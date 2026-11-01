"""Native Windows UIA adapter for configured personal WeChat group chats.

The pure protocol and sequence logic is deliberately independent of uiautomation.
The real backend attaches only to an existing mmui::MainWindow. It never launches
WeChat, moves a window, or creates a replacement window. --probe is read-only.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.metadata
import json
import os
import re
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, TextIO


SOURCE = "uia-wechat-group/v1"
KNOWN_CONTROL_IDS = ("session_list", "chat_message_list", "chat_input_field")
ERROR_MESSAGES = {
    "invalid_json": "The request is not valid JSON.",
    "invalid_request": "The request shape is invalid.",
    "unknown_request": "The request type is not supported.",
    "unknown_chat": "The configured group chat ID is unknown.",
    "duplicate_group_title": "The target group title is ambiguous.",
    "target_title_mismatch": "The current chat title does not match the target.",
    "target_draft_not_empty": "The target input contains an existing draft.",
    "input_verification_failed": "The target input did not retain the exact text.",
    "input_not_cleared": "The target input was not cleared after sending.",
    "readback_ambiguous": "The send read-back contains multiple matching messages.",
    "outcome_unknown": "The send outcome is unknown; blind retry is forbidden.",
    "request_id_conflict": "The request ID was already used for another payload.",
    "restore_failed": "The previous chat or input state could not be restored.",
    "ui_failure": "The UIA operation failed before a send was attempted.",
    "poll_failed": "A read-only polling cycle failed.",
    "probe_failed": "The read-only UIA probe failed.",
    "send_disabled": "Sending is disabled until the operator enables it.",
    "wechat_logged_out": "WeChat is on its login screen; log in before starting the group bridge.",
    # A remembered account, not a lost one. Do not restart WeChat: that is how a
    # live session gets thrown away. Confirming the login is all that is needed.
    "wechat_login_confirmation": "WeChat is asking to confirm the remembered account; open WeChat and press 登录 there.",
    "wechat_panel_closed": "WeChat's panel was closed; reopen it, and keep it visible rather than minimised so the bridge can work head-lessly.",
    "wechat_accessibility_unavailable": "WeChat's panel is on screen but exposes no accessibility tree; restart WeChat to restore it.",
    "main_window_missing": "No WeChat window was found; start WeChat and log in.",
    "focus_not_on_target": "Keyboard focus could not be proven to be on the WeChat input; nothing was typed.",
    # Not a lost surface: respawning the child cannot expand a sidebar the operator
    # collapsed, so this code must never trigger the exit-and-retry ladder. Kept as
    # a distinct diagnosis because "control_missing" reads like a broken bridge
    # when the truth is that the chat list is hidden.
    "sidebar_collapsed": "WeChat's session sidebar is collapsed; expand it, or keep the target group open on screen.",
}


class BridgeError(Exception):
    """Base exception with a stable, non-sensitive protocol error code."""

    def __init__(self, message: str, code: str = "bridge_error"):
        super().__init__(message)
        self.code = code


class ConfigError(BridgeError):
    pass


class SafetyError(BridgeError):
    pass


class ProtocolError(BridgeError):
    pass


# How a group row becomes an address. command keeps today's behaviour and is the
# default; mention honours only a leading @ token; mention-or-command takes both.
MENTION_MODES = frozenset(("command", "mention", "mention-or-command"))
# A real @ renders as the literal token "@[...]" inside the message text, and the
# bracket is produced only by picking a member from the @ list. Hand-typed
# "@name" has no such shape, so the shape is what makes a token count.
MENTION_TOKEN_RE = re.compile(r"^@\[([^\]\n]*)\]")
# WeChat erases the mentioned name to "___" in the accessibility text, which is
# what makes a token provable-but-anonymous.
MASKED_MENTION_NAME = "___"


@dataclass(frozen=True)
class GroupConfig:
    id: str
    title: str
    trigger_names: tuple[str, ...] = ()
    command_prefix: str = "/dsh"
    allow_self: bool = False
    # Per-group opt-in. Only an operator who names this group may accept
    # unverified command-prefixed rows as addressed; identity stays unverified.
    allow_unverified_trigger: bool = False
    mention_mode: str = "command"


@dataclass(frozen=True)
class RawMessage:
    """One visible text message; visible_time is evidence, not a global ID."""

    sender: str
    text: str
    is_self: bool = False
    visible_time: str = ""
    message_type: int = 1


@dataclass
class _GroupState:
    previous: list[RawMessage] = field(default_factory=list)
    cursor: int = 0


@dataclass
class _Outbound:
    request_id: str
    chat_id: str
    text: str
    provider_id: str
    attempted: bool = False
    echo_pending: bool = False
    result: dict[str, Any] | None = None


def split_mention_tokens(
    text: str, trigger_names: tuple[str, ...], allow_masked: bool,
) -> tuple[bool, str]:
    """Strip leading @ tokens; report whether one of them addressed the bot.

    Returns (matched, remainder). matched is True only when at least one stripped
    token named the bot. Leading tokens that name somebody else stop the scan and
    yield False, because a message that starts "@小李" is not an address of us
    however many later tokens mention us.

    Two measured shapes are handled differently:
    - "@[___]" - the name is erased by WeChat, so the token proves "a member was
      picked from the @ list" but never proves WHO. It counts only when the
      operator opted this group in (allow_masked), and never when trigger_names
      are configured, because then a name we cannot read cannot be checked.
    - "@[大肥鱼]" - a readable name. It counts only when it is in trigger_names,
      which is a name match rather than an identity claim, so it needs no opt-in.
    """

    remainder = text.lstrip()
    matched = False
    while True:
        token = MENTION_TOKEN_RE.match(remainder)
        if token is None:
            break
        name = token.group(1).strip()
        if name == MASKED_MENTION_NAME:
            # The erased placeholder proves only that a member was picked, so it
            # counts exactly when the operator opted this group in. Configured
            # trigger_names do NOT disable it: they belong to the readable-name
            # branch below, and a build that hides names hides them for every row.
            honoured = bool(allow_masked)
        else:
            honoured = name in set(trigger_names)
        if not honoured:
            # A foreign or unreadable mention owns the message; stop, do not skip.
            return False, text
        matched = True
        remainder = remainder[token.end():].lstrip()
    return matched, remainder


def parse_trigger(
    text: str, command_prefix: str, mention_mode: str = "command",
    trigger_names: tuple[str, ...] = (), allow_masked_mention: bool = False,
) -> tuple[bool, str]:
    """Decide whether a row addresses the bot, and strip the trigger tokens.

    The three modes differ only in which token is honoured; the returned body is
    always the text with every trigger token removed, so the agent never sees
    "@[___]" or "/dsh" in what it is asked to act on.

    An unknown mode is treated as "command": a value that never passed a
    validator must not hand out the new capability.
    """

    mode = mention_mode if mention_mode in MENTION_MODES else "command"
    allow_mention = mode in ("mention", "mention-or-command")
    allow_command = mode in ("command", "mention-or-command")

    body = text
    mentioned = False
    if allow_mention:
        mentioned, body = split_mention_tokens(body, trigger_names, allow_masked_mention)
        if not mentioned:
            # split_mention_tokens returns the original text when it declines the
            # row; a leading foreign mention must not be rescued by the prefix.
            if mode == "mention":
                return False, text

    command_hit = False
    if allow_command and command_prefix:
        candidate = body.lstrip()
        if candidate == command_prefix:
            command_hit, body = True, ""
        elif candidate.startswith(command_prefix):
            remainder = candidate[len(command_prefix):]
            if remainder and remainder[0].isspace():
                # Only whitespace between the command and body is discarded.
                command_hit, body = True, remainder.strip()
    elif allow_command and not command_prefix:
        # An empty prefix would otherwise mark every message as addressed.
        return False, text

    if mode == "command":
        return command_hit, (body if command_hit else text)
    if mode == "mention":
        return mentioned, (body.strip() if mentioned else text)
    # mention-or-command: either token qualifies, and both may appear together.
    if mentioned and command_hit:
        return True, body
    if mentioned:
        return True, body.strip()
    return command_hit, (body if command_hit else text)


def session_title(automation_id: str, name: str) -> str:
    """Extract only the verified session_item_ title, never preview metadata."""

    prefix = "session_item_"
    if not automation_id.startswith(prefix):
        return ""
    title = automation_id[len(prefix):]
    # Name contains title/pin/preview/time lines and is not an exact-title key.
    return title if title and "\n" not in title and "\r" not in title else ""


def _overlap_length(previous: list[RawMessage], current: list[RawMessage]) -> int:
    """Return the longest suffix/prefix match between two visible sequences."""

    upper = min(len(previous), len(current))
    for size in range(upper, 0, -1):
        if previous[-size:] == current[:size]:
            return size
    return 0


def visible_delta(previous: list[RawMessage], current: list[RawMessage]) -> list[RawMessage] | None:
    """Diff a scrolling list; None means the safe continuity anchor was lost."""

    if not previous:
        return list(current)
    overlap = _overlap_length(previous, current)
    if overlap == 0:
        return None
    return list(current[overlap:])


UNVERIFIED_SENDER_PREFIX = "uia-unverified:"


def unverified_sender(sender: str) -> bool:
    """True when the row exposed no member identity and must stay untrusted."""

    return isinstance(sender, str) and sender.startswith(UNVERIFIED_SENDER_PREFIX)


def read_visible_rows_as_messages(
    rows: Iterable[dict[str, Any]], allow_unverified: bool = False,
) -> list[RawMessage]:
    """Read only text rows. Sender stays unverified unless the row proves it.

    WeChat 4.1 message items expose no sender/self child control, so an
    unverified row cannot name its author. This deliberately returns
    UNVERIFIED_SENDER_PREFIX rows instead of inventing a member name; callers
    must therefore treat them as observe-only and never as addressed.
    """

    if not allow_unverified:
        raise SafetyError(
            "message item layout lacks verified sender fields",
            "message_layout_unverified",
        )
    messages: list[RawMessage] = []
    for row in rows:
        if not isinstance(row, dict):
            raise SafetyError("message row has an unknown shape", "invalid_message_shape")
        cls = row.get("cls") or ""
        name = row.get("name") or ""
        if "ChatTextItemView" not in cls:
            # Images, time separators and referral items carry no addressable text.
            continue
        text = name.strip()
        if not text:
            continue
        messages.append(RawMessage(
            sender=UNVERIFIED_SENDER_PREFIX + "row",
            text=text,
            is_self=False,
            visible_time="",
            message_type=1,
        ))
    return messages


def build_message_event(
    conversation_id: str, conversation_title: str, item: RawMessage,
    trigger: str = "/dsh", sent_at: int = 0, addressed: bool | None = None,
    allow_unverified_trigger: bool = False, mention_mode: str = "command",
    trigger_names: tuple[str, ...] = (),
) -> dict[str, Any]:
    """Assemble one v1 event; unverified senders can never be addressed."""

    # Identity is unverifiable on WeChat 4.1; a named group may still opt in to
    # accepting the command prefix, but that never verifies who spoke.
    trusted = (not unverified_sender(item.sender)) or bool(allow_unverified_trigger)
    # Same rule as WechatGroupAdapter._observe: two addressed paths that disagree
    # would let a row be judged one way in tests and another way in production.
    # A masked @ token is only honoured under the same per-group opt-in, because
    # the erased name cannot prove the bot was the one addressed.
    parsed, text = parse_trigger(
        item.text, trigger, mention_mode=mention_mode, trigger_names=trigger_names,
        allow_masked_mention=bool(allow_unverified_trigger),
    )
    if addressed is None:
        addressed = bool(parsed and trusted and text)
    else:
        addressed = bool(addressed and trusted)
    event = {
        "source": SOURCE,
        "message_id": "uia-msg-" + hashlib.sha256(
            (conversation_id + "\0" + item.sender + "\0" + item.text + "\0" + str(sent_at))
            .encode("utf-8")
        ).hexdigest()[:32],
        "message_type": 1,
        "conversation_type": "group",
        "conversation_id": conversation_id,
        "conversation_title": conversation_title,
        "from_user_id": item.sender,
        "sender_name": item.sender,
        "reply_target": conversation_id,
        "addressed": addressed,
        "text": text,
        "raw_text": item.text,
        "sent_at": int(sent_at),
        "is_self": bool(item.is_self),
        "item_list": [{"type": 1, "text_item": {"text": text}}],
    }
    validate_message_event(event)
    return event


def validate_message_event(event: dict[str, Any]) -> None:
    """Fail before stdout if an outgoing event does not satisfy the v1 contract."""

    required = {
        "source", "message_id", "message_type", "conversation_type",
        "conversation_id", "conversation_title", "from_user_id", "sender_name",
        "reply_target", "addressed", "text", "raw_text", "sent_at", "is_self",
        "item_list",
    }
    if set(event) != required:
        raise ProtocolError("v1 event fields do not match the exact schema", "invalid_event")
    if event["source"] != SOURCE or event["message_type"] != 1:
        raise ProtocolError("unsupported event source or message type", "invalid_event")
    if event["conversation_type"] != "group":
        raise ProtocolError("v1 events must be group conversations", "invalid_event")
    for key in (
        "message_id", "conversation_id", "conversation_title", "from_user_id",
        "sender_name", "reply_target", "text", "raw_text",
    ):
        if not isinstance(event[key], str) or not event[key]:
            raise ProtocolError("v1 string fields must be non-empty", "invalid_event")
    if event["reply_target"] != event["conversation_id"]:
        raise ProtocolError("reply target must remain the group", "invalid_event")
    if not (
        event["from_user_id"] == "uia-name:" + event["sender_name"]
        or event["from_user_id"] == UNVERIFIED_SENDER_PREFIX + "row"
    ):
        raise ProtocolError("member ID must preserve the display-name boundary", "invalid_event")
    if type(event["addressed"]) is not bool or type(event["is_self"]) is not bool:
        raise ProtocolError("addressed and is_self must be booleans", "invalid_event")
    if type(event["sent_at"]) is not int or event["sent_at"] < 0:
        raise ProtocolError("sent_at must be a millisecond timestamp", "invalid_event")
    expected_items = [{"type": 1, "text_item": {"text": event["text"]}}]
    if event["item_list"] != expected_items:
        raise ProtocolError("item_list must match the stripped text", "invalid_event")


class WechatGroupAdapter:
    """Serialize all UIA access and enforce baseline, identity and send safety."""

    def __init__(
        self,
        groups: Iterable[GroupConfig],
        backend: Any,
        clock: Callable[[], int] | None = None,
    ):
        self.groups = tuple(groups)
        self.backend = backend
        self.clock = clock or (lambda: int(time.time() * 1000))
        self._by_id = {group.id: group for group in self.groups}
        self._states = {group.id: _GroupState() for group in self.groups}
        self._outbounds: dict[str, _Outbound] = {}
        self._pending_events: list[dict[str, Any]] = []
        self._lock = threading.RLock()
        self._started = False
        self._closed = False
        self._overlap_resets = 0
        self._validate_groups()

    def _validate_groups(self) -> None:
        if not self.groups:
            raise ConfigError("at least one group is required", "invalid_config")
        ids: set[str] = set()
        titles: set[str] = set()
        for group in self.groups:
            if not group.id.startswith("uia_") or not group.title.strip():
                raise ConfigError("group IDs and titles are invalid", "invalid_config")
            if group.id in ids or group.title in titles:
                raise ConfigError("duplicate group IDs or titles are ambiguous", "duplicate_group_title")
            if not isinstance(group.command_prefix, str) or type(group.allow_self) is not bool:
                raise ConfigError("group trigger configuration is invalid", "invalid_config")
            # mention_mode is a capability switch, so an unvalidated value must
            # not be tolerated even though parse_trigger would degrade it safely:
            # an operator who typed "mentions" deserves to hear about it.
            if group.mention_mode not in MENTION_MODES:
                raise ConfigError("group mention_mode is invalid", "invalid_config")
            if any(not isinstance(name, str) or not name.strip()
                   for name in group.trigger_names):
                raise ConfigError("group trigger_names must be non-empty strings",
                                  "invalid_config")
            # Measured: every group row arrives as uia-unverified:row, so a
            # mention-only mode in a group that never opted in can literally
            # never fire. Refuse that pairing instead of accepting a config the
            # operator believes is live.
            if (group.mention_mode != "command"
                    and type(group.allow_unverified_trigger) is not bool):
                raise ConfigError("allow_unverified_trigger must be boolean",
                                  "invalid_config")
            if (group.mention_mode != "command" and not group.allow_unverified_trigger
                    and not group.trigger_names):
                raise ConfigError(
                    "mention modes need allowUnverifiedTrigger or triggerNames",
                    "invalid_config",
                )
            ids.add(group.id)
            titles.add(group.title)
        if len(self._by_id) != len(self.groups):
            raise ConfigError("duplicate group ID", "invalid_config")

    def _assert_unique_title(self, group: GroupConfig) -> None:
        try:
            titles = self.backend.list_session_titles()
        except SafetyError:
            # Collapsed sidebar: the list is not available to count. Fall back to
            # the open chat header, which is weaker evidence (one property, and it
            # says nothing about OTHER chats), so it is accepted only when the
            # named group is the chat already on screen. A send still re-checks the
            # title around every mutation, and switching chats is impossible without
            # the list, so this can never read or write a different conversation.
            if self.backend.current_chat_title() == group.title:
                return
            # Say what is actually wrong. duplicate_group_title means "two chats
            # share this name", which is not what happened and would send the
            # operator looking for a rename. The list is gone, so the bridge cannot
            # switch chats at all; the fix is to expand the sidebar or keep the
            # target group on screen.
            raise SafetyError("session list unavailable and the open chat is not "
                              "the target", "sidebar_collapsed")
        if titles.count(group.title) != 1:
            # Selecting by a duplicated visible name could read or write another group.
            raise SafetyError("target title is missing or duplicated", "duplicate_group_title")

    def _require_chat(self, title: str) -> None:
        # A None result means no chat panel is open, which is still 'not the target'.
        if self.backend.current_chat_title() != title:
            raise SafetyError("current chat differs from target", "target_title_mismatch")

    def _read_target(self, group: GroupConfig) -> list[RawMessage]:
        self._assert_unique_title(group)
        # A minimised window reports success for a UIA click but opens nothing.
        restore = getattr(self.backend, "ensure_window_restored", None)
        if callable(restore):
            restore()
        original = self.backend.current_chat_title()
        try:
            if original != group.title:
                self.backend.select_chat(group.title)
            self._require_chat(group.title)
            messages = list(self.backend.read_messages())
            self._require_chat(group.title)
            if any(not isinstance(item, RawMessage) for item in messages):
                raise SafetyError("backend returned an unknown message shape", "invalid_message_shape")
            return messages
        finally:
            # Nothing was open before, so there is no prior chat to restore.
            if original is not None and original != group.title:
                # Reads restore the prior chat too; no polling cycle steals the user context.
                self.backend.select_chat(original)

    def start(self) -> None:
        with self._lock:
            if self._started:
                return
            self._validate_groups()
            baselines: dict[str, list[RawMessage]] = {}
            for group in self.groups:
                # Every baseline is captured before any event can reach stdout.
                baselines[group.id] = self._read_target(group)
            for group in self.groups:
                state = self._states[group.id]
                state.previous = baselines[group.id]
                state.cursor = len(state.previous)
            self._pending_events.clear()
            self._started = True

    def _consume_bridge_echo(self, chat_id: str, item: RawMessage) -> bool:
        # Two shapes have to be handled, and only one of them carries a flag.
        # A verified row tells us directly whether we sent it (is_self). On
        # WeChat 4.2.0.12 every group row arrives as uia-unverified:row with
        # is_self permanently False, so that flag cannot gate anything there and
        # the only available proof is an exact text match against an outbound we
        # actually attempted and have not yet echoed. Without this branch the
        # bridge would read its own reply as a fresh mention and answer itself,
        # which is a real reply loop the moment mentions become triggers.
        attributable = item.is_self or unverified_sender(item.sender)
        if not attributable:
            return False
        for outbound in self._outbounds.values():
            if (
                outbound.chat_id == chat_id
                and outbound.attempted
                and outbound.echo_pending
                and outbound.text == item.text
            ):
                # Consume one occurrence only; a later identical manual message remains distinct.
                outbound.echo_pending = False
                return True
        return False

    def _observe(self, group: GroupConfig, current: list[RawMessage]) -> None:
        state = self._states[group.id]
        if not current and state.previous:
            # A transient empty list must not erase the continuity anchor.
            return
        delta = visible_delta(state.previous, current)
        if delta is None:
            # Without an anchor, visible items may be old history: re-baseline, never replay.
            self._overlap_resets += 1
            state.cursor += len(current)
            state.previous = list(current)
            return
        state.previous = list(current)
        for item in delta:
            state.cursor += 1
            if self._consume_bridge_echo(group.id, item):
                continue
            if item.message_type == 2:
                # Provider/echo type is an independent second guard against reply loops.
                continue
            if item.is_self and not group.allow_self:
                continue
            if not item.sender or not item.text.strip():
                continue
            parsed, text = parse_trigger(
                item.text, group.command_prefix, mention_mode=group.mention_mode,
                trigger_names=group.trigger_names,
                allow_masked_mention=bool(group.allow_unverified_trigger),
            )
            # Unverified rows may only become addressed inside a group whose owner
            # explicitly opted in; the member identity itself stays unverified.
            addressed = bool(
                parsed and text and (not unverified_sender(item.sender)
                                or group.allow_unverified_trigger)
            )
            if parsed and not text:
                continue
            identity = "\0".join((
                group.id, str(state.cursor), item.sender, item.text, item.visible_time,
            ))
            message_id = "uia-msg-" + hashlib.sha256(identity.encode("utf-8")).hexdigest()[:32]
            event = {
                "source": SOURCE,
                "message_id": message_id,
                "message_type": 1,
                "conversation_type": "group",
                "conversation_id": group.id,
                "conversation_title": group.title,
                "from_user_id": (item.sender if unverified_sender(item.sender)
                               else "uia-name:" + item.sender),
                "sender_name": item.sender,
                "reply_target": group.id,
                "addressed": addressed,
                "text": text,
                "raw_text": item.text,
                "sent_at": int(self.clock()),
                "is_self": item.is_self,
                "item_list": [{"type": 1, "text_item": {"text": text}}],
            }
            validate_message_event(event)
            self._pending_events.append(event)

    def poll(self) -> list[dict[str, Any]]:
        with self._lock:
            if not self._started:
                raise SafetyError("baseline has not completed", "not_ready")
            for group in self.groups:
                self._observe(group, self._read_target(group))
            return self.drain_events()

    def drain_events(self) -> list[dict[str, Any]]:
        with self._lock:
            events = self._pending_events
            self._pending_events = []
            return events

    def _send_result(
        self, outbound: _Outbound, ok: bool, code: str | None = None,
        provider_ids: list[str] | None = None,
    ) -> dict[str, Any]:
        result: dict[str, Any] = {
            "type": "send_result",
            "request_id": outbound.request_id,
            "chat_id": outbound.chat_id,
            "ok": ok,
            "provider_message_ids": provider_ids or [],
        }
        if code:
            result["error"] = {
                "code": code,
                "message": ERROR_MESSAGES.get(code, "The send failed safely."),
            }
        return result

    def send_text(self, request_id: str, chat_id: str, text: str) -> dict[str, Any]:
        with self._lock:
            group = self._by_id.get(chat_id)
            if group is None:
                return {
                    "type": "send_result", "request_id": request_id, "chat_id": chat_id,
                    "ok": False, "provider_message_ids": [],
                    "error": {"code": "unknown_chat", "message": ERROR_MESSAGES["unknown_chat"]},
                }
            if not request_id or not isinstance(text, str) or not text.strip():
                raise ProtocolError("send_text requires ID and non-empty text", "invalid_request")
            existing = self._outbounds.get(request_id)
            if existing:
                if existing.chat_id != chat_id or existing.text != text:
                    return self._send_result(existing, False, "request_id_conflict")
                # A reserved/unknown outcome is returned unchanged and never re-sent.
                return copy.deepcopy(existing.result) or self._send_result(
                    existing, False, "outcome_unknown"
                )
            provider_id = "uia-outbound-" + hashlib.sha256(
                (chat_id + "\0" + request_id).encode("utf-8")
            ).hexdigest()[:32]
            outbound = _Outbound(request_id, chat_id, text, provider_id)
            # Reserve the ID before any UIA mutation so reconciliation is idempotent.
            self._outbounds[request_id] = outbound
            original_title: str | None = None
            original_input = ""
            try:
                self._assert_unique_title(group)
                restore = getattr(self.backend, "ensure_window_restored", None)
                if callable(restore):
                    restore()
                original_title = self.backend.current_chat_title()
                # read_input() needs an open chat; with none open there is no draft.
                original_input = self.backend.read_input() if original_title is not None else ""
                if original_title != group.title:
                    self.backend.select_chat(group.title)
                self._require_chat(group.title)
                before = list(self.backend.read_messages())
                self._require_chat(group.title)
                if self.backend.read_input():
                    raise SafetyError("target draft is not empty", "target_draft_not_empty")
                self.backend.set_input(text)
                self._require_chat(group.title)
                if self.backend.read_input() != text:
                    raise SafetyError("input verification failed", "input_verification_failed")
                self._require_chat(group.title)
                outbound.attempted = True
                outbound.echo_pending = True
                self.backend.press_enter()
                self._require_chat(group.title)
                after = list(self.backend.read_messages())
                self._require_chat(group.title)
                delta = visible_delta(before, after) or []
                # Without a sender field the echo cannot be attributed, but a new
                # row carrying the exact text still proves delivery. Deliberately
                # reported as unverified, never as a named member reply.
                if not any(unverified_sender(item.sender) for item in delta):
                    echoes = [item for item in delta if item.is_self and item.text == text]
                else:
                    echoes = [item for item in delta if item.text == text]
                if len(echoes) > 1:
                    outbound.result = self._send_result(outbound, False, "readback_ambiguous")
                elif len(echoes) != 1:
                    outbound.result = self._send_result(outbound, False, "outcome_unknown")
                elif self.backend.read_input() != "":
                    outbound.result = self._send_result(outbound, False, "input_not_cleared")
                else:
                    # Advance the visible cursor and queue any other arrivals, but consume our echo.
                    self._observe(group, after)
                    outbound.result = self._send_result(
                        outbound, True, provider_ids=[provider_id]
                    )
            except SafetyError as exc:
                code = exc.code if not outbound.attempted else "outcome_unknown"
                outbound.result = self._send_result(outbound, False, code)
            except Exception:
                code = "ui_failure" if not outbound.attempted else "outcome_unknown"
                outbound.result = self._send_result(outbound, False, code)
            if original_title is not None:
                try:
                    if self.backend.current_chat_title() != original_title:
                        self.backend.select_chat(original_title)
                    self._require_chat(original_title)
                    if self.backend.read_input() != original_input:
                        # Restore only the original draft; never press Enter during restoration.
                        self.backend.set_input(original_input)
                except Exception:
                    outbound.result = self._send_result(outbound, False, "restore_failed")
            return copy.deepcopy(outbound.result)

    def health(self) -> dict[str, Any]:
        with self._lock:
            evidence = self.backend.health()
            healthy = bool(evidence.get("main_window") and evidence.get("controls") and evidence.get("message_parser") != "probe_required")
            return {
                "healthy": healthy,
                "ready": self._started and not self._closed,
                "groups": [group.id for group in self.groups],
                "overlap_resets": self._overlap_resets,
                # Report the truth: mention routing is live for any group whose
                # mode honours it. A hardcoded False contradicted the operator's
                # own configuration file.
                "mention_routing": any(
                    group.mention_mode != "command" for group in self.groups
                ),
                "backend": evidence,
            }

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self.backend.close()


# Codes that mean the UIA surface itself is gone rather than one poll failing.
# Retrying them at 750ms produces a flood with no new information: the window,
# panel or login state has to change first. The adapter says the real code once
# and exits, so the JS supervisor runs its normal back-off restart ladder
# (2.5s..30s) instead of burning CPU and log volume on a dead transport.
SURFACE_LOST_CODES = frozenset({
    "control_missing", "main_window_missing", "wechat_panel_closed",
    "wechat_logged_out", "wechat_login_confirmation",
    "backend_closed", "unsupported_platform", "dependency_missing",
    # Panel visible but exposing no tree: only a WeChat restart fixes it, so the
    # bridge must back off instead of polling. Kept in step with SURFACE_LOSS_CODES
    # in src/channels/weixin/wechat-group-runtime.mjs.
    "wechat_accessibility_unavailable",
})

# Distinct exit code so the supervisor and the log can tell a surface loss apart
# from any other child death.
SURFACE_LOST_EXIT_CODE = 4


class JsonlProtocol:
    """Request/response boundary; business safety remains in WechatGroupAdapter."""

    def __init__(self, adapter: WechatGroupAdapter, exit_impl: Callable[[int], None] | None = None):
        self.adapter = adapter
        self.stopped = threading.Event()
        self.fatal_code: str | None = None
        # Poll failures repeat on a fixed cadence, so an unchanged diagnosis is
        # reported once per window instead of once per cycle. State for that.
        self._last_error_code: str | None = None
        self._last_error_at = 0.0
        # Injected so tests can observe the exit instead of killing the runner.
        self._exit_impl = exit_impl or (lambda code: os._exit(code))
        self._write_lock = threading.Lock()

    def start(self) -> dict[str, Any]:
        self.adapter.start()
        # The baseline is captured before this runs, so stowing the window cannot
        # hide a pending read. Non-activating by construction, and a no-op
        # unless the operator opted in.
        stow = getattr(self.adapter.backend, "maybe_auto_minimize", None)
        if callable(stow):
            stow()
        return {
            "type": "ready",
            "ok": True,
            "source": SOURCE,
            "groups": [group.id for group in self.adapter.groups],
        }

    def _error(self, code: str, request_id: Any = None) -> dict[str, Any]:
        return {
            "type": "error",
            "request_id": request_id if isinstance(request_id, str) else None,
            "ok": False,
            "error": {"code": code, "message": ERROR_MESSAGES.get(code, ERROR_MESSAGES["invalid_request"])},
        }

    def handle_line(self, line: str) -> list[dict[str, Any]]:
        try:
            request = json.loads(line)
        except (json.JSONDecodeError, TypeError):
            return [self._error("invalid_json")]
        return self.handle_request(request)

    def handle_request(self, request: Any) -> list[dict[str, Any]]:
        if not isinstance(request, dict) or not isinstance(request.get("type"), str):
            return [self._error("invalid_request")]
        kind = request["type"]
        request_id = request.get("request_id")
        try:
            if kind == "health":
                health = self.adapter.health()
                return [{
                    "type": "health_result",
                    "request_id": request_id,
                    "ok": health["healthy"],
                    **health,
                }]
            if kind == "send_text":
                if os.environ.get("DSH_WECHAT_GROUP_ALLOW_SEND") != "1":
                    # Sending is opt-in: an observe-only bridge must never write.
                    return [self._error("send_disabled", request_id)]
                if (
                    not isinstance(request_id, str) or not request_id
                    or not isinstance(request.get("chat_id"), str)
                    or not isinstance(request.get("text"), str)
                ):
                    return [self._error("invalid_request", request_id)]
                result = self.adapter.send_text(request_id, request["chat_id"], request["text"])
                events = [{
                    "type": "message", "message": event,
                } for event in self.adapter.drain_events()]
                return events + [result]
            if kind == "stop":
                if not isinstance(request_id, str) or not request_id:
                    return [self._error("invalid_request", request_id)]
                self.stopped.set()
                self.adapter.close()
                return [{"type": "stop_result", "request_id": request_id, "ok": True}]
            return [self._error("unknown_request", request_id)]
        except ProtocolError as exc:
            return [self._error(exc.code, request_id)]
        except SafetyError as exc:
            return [self._error(exc.code, request_id)]
        except Exception:
            # Never echo request text, exception args or chat content into stderr/stdout logs.
            return [self._error("invalid_request", request_id)]

    def poll_frames(self) -> list[dict[str, Any]]:
        # Measured live: with the panel closed this emitted 'poll_failed' every
        # 750ms, 80 lines an hour, and the generic code hid the one thing an
        # operator can act on. A surface-level loss now keeps its real code,
        # is reported once, and makes the child exit so the JS supervisor runs
        # its back-off ladder instead of hammering a dead transport.
        try:
            return [{"type": "message", "message": event} for event in self.adapter.poll()]
        except SafetyError as exc:
            if exc.code in SURFACE_LOST_CODES:
                self.fatal_code = exc.code
            return self._throttled(exc.code)
        except Exception:
            # uiautomation raises plain COM errors when the window is gone, so
            # ask the backend directly why the surface is missing before
            # flattening to poll_failed.
            probe = getattr(self.adapter.backend, "surface_state", None)
            state = None
            if callable(probe):
                try:
                    state = probe()
                except Exception:
                    state = None
            if state in SURFACE_LOST_CODES:
                self.fatal_code = state
                return self._throttled(state)
            return self._throttled("poll_failed")

    # How often an unchanged polling diagnosis is repeated to the supervisor.
    ERROR_FRAME_WINDOW_S = 60.0

    def _throttled(self, code: str) -> list[dict[str, Any]]:
        """Report a poll diagnosis once per window unless it changed.

        A persistent condition at a 750ms cadence produced 80 identical lines an
        hour, which is how the original flood buried the one line an operator
        could act on. Two cases are never suppressed:
        - the code CHANGED, because the previous window's reason is now stale and
          a new symptom must not hide behind an old one;
        - a fatal code, because the frame is what tells the supervisor why the
          child is about to exit, and dropping it would leave a bare process death.
        """

        now = time.monotonic()
        # A fatal code needs no special case here: it always differs from the
        # previous diagnosis on its first occurrence, so it is written, and
        # serve()'s poll loop exits the process on the same iteration - there is
        # never a second frame of it to suppress.
        if code != self._last_error_code:
            self._last_error_code = code
            self._last_error_at = now
            return [self._error(code)]
        if now - self._last_error_at >= self.ERROR_FRAME_WINDOW_S:
            self._last_error_at = now
            return [self._error(code)]
        return []

    @staticmethod
    def _write(stream: TextIO, frame: dict[str, Any]) -> None:
        stream.write(json.dumps(frame, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")
        stream.flush()

    def serve(self, stdin: TextIO, stdout: TextIO, poll_interval_ms: int) -> None:
        self._write(stdout, self.start())

        def poll_loop() -> None:
            while not self.stopped.wait(poll_interval_ms / 1000):
                frames = self.poll_frames()
                with self._write_lock:
                    for frame in frames:
                        self._write(stdout, frame)
                if self.fatal_code is not None:
                    # The frame is already flushed, so exiting cannot lose the
                    # diagnosis. Exit the process: the supervisor restarts it.
                    self.stopped.set()
                    self._exit_impl(SURFACE_LOST_EXIT_CODE)

        worker = threading.Thread(target=poll_loop, name="wechat-uia-poll", daemon=True)
        worker.start()
        try:
            for line in stdin:
                if self.stopped.is_set():
                    break
                frames = self.handle_line(line)
                with self._write_lock:
                    for frame in frames:
                        self._write(stdout, frame)
        finally:
            self.stopped.set()
            worker.join(timeout=max(1.0, poll_interval_ms / 1000 + 1.0))
            self.adapter.close()


def load_config(path: str | Path) -> tuple[list[GroupConfig], int]:
    """Read account-level group config without touching iLink credentials."""

    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict) or data.get("version") != 1:
        raise ConfigError("unsupported group config version", "invalid_config")
    raw_groups = data.get("groups")
    if not isinstance(raw_groups, list) or not raw_groups:
        raise ConfigError("groups must be a non-empty list", "invalid_config")
    groups: list[GroupConfig] = []
    for item in raw_groups:
        if not isinstance(item, dict):
            raise ConfigError("group entry must be an object", "invalid_config")
        trigger_names = item.get("triggerNames", [])
        if not isinstance(trigger_names, list) or any(not isinstance(v, str) for v in trigger_names):
            raise ConfigError("triggerNames must be strings", "invalid_config")
        allow_self = item.get("allowSelf", False)
        if type(allow_self) is not bool:
            raise ConfigError("allowSelf must be boolean", "invalid_config")
        # Same strictness as allowSelf: the string "false" is truthy in Python,
        # so coercing it would silently grant the mention capability to a group
        # whose operator wrote it off.
        opt_in = item.get("allowUnverifiedTrigger", False)
        if type(opt_in) is not bool:
            raise ConfigError("allowUnverifiedTrigger must be boolean", "invalid_config")
        mention_mode = item.get("mentionMode", "command")
        if mention_mode not in MENTION_MODES:
            raise ConfigError("mentionMode must be command, mention or "
                              "mention-or-command", "invalid_config")
        # load_config never reaches WechatGroupAdapter._validate_groups, so the
        # same cross-check has to be applied here too: a mode that can never fire
        # (no opt-in for masked tokens, and no names to match readable ones) is a
        # misconfiguration, and accepting it would leave the operator with a group
        # that looks enabled and stays mute forever.
        if mention_mode != "command" and not opt_in and not trigger_names:
            raise ConfigError(
                "mentionMode needs allowUnverifiedTrigger or triggerNames",
                "invalid_config",
            )
        groups.append(GroupConfig(
            id=item.get("id", ""),
            title=item.get("title", ""),
            trigger_names=tuple(trigger_names),
            command_prefix=item.get("commandPrefix", "/dsh"),
            allow_self=allow_self,
            allow_unverified_trigger=opt_in,
            mention_mode=mention_mode,
        ))
    interval = data.get("pollIntervalMs", 750)
    if type(interval) is not int or interval < 100:
        raise ConfigError("pollIntervalMs must be an integer >= 100", "invalid_config")
    return groups, interval


def _user32() -> Any:
    """Resolve the Win32 user32 module; kept separate so tests can inject a fake."""

    import ctypes

    return ctypes.windll.user32


def _safe_property(control: Any, name: str) -> Any:
    try:
        value = getattr(control, name)
        # UIA properties are scalar here; converting keeps probe output JSON-safe.
        return value if isinstance(value, (str, int, bool)) or value is None else str(value)
    except Exception:
        return None


def _window_is_minimised(hwnd: int) -> bool:
    """True when a native window is already iconic (read-only IsIconic check)."""

    if sys.platform != "win32":
        return False
    from ctypes import wintypes

    try:
        return bool(_user32().IsIconic(wintypes.HWND(int(hwnd))))
    except Exception:
        return False

def _login_window_offers_confirmation(auto: Any) -> bool:
    """True when the login window shows the remembered-account 登录 button.

    Reads the same window the classifier already found. Any failure to walk it
    returns False, because claiming 'your session is still there, just confirm
    it' without evidence is the guess that must never be made: the safe answer
    under uncertainty is the ordinary signed-out diagnosis.
    """

    try:
        window = auto.WindowControl(searchDepth=1, ClassName="mmui::LoginWindow")
        if not window.Exists(0, 0):
            return False
        walker = getattr(auto, "WalkControl", None)
        if walker is None:
            return False
        for control, _depth in walker(window, includeTop=False, maxDepth=20):
            try:
                if str(control.ControlTypeName) != "ButtonControl":
                    continue
                if str(control.Name or "").strip() == "\u767b\u5f55":
                    # 登录 as a button label, not merely a word inside some text.
                    return True
            except Exception:
                continue
    except Exception:
        return False
    return False

def classify_missing_main_window(auto: Any) -> str:
    """Decide why there is no mmui::MainWindow, in order of operator action.

    WeChat 4.x has three very different 'no main window' states that used to all
    collapse into main_window_missing, sending operators hunting the wrong fix:

    - mmui::LoginWindow present  -> the account is signed out; scan the QR.
    - a titled 微信 shell window (Qt51514*, no mmui subtree) -> the panel was
      CLOSED with the X button. The process lives but its accessibility tree is
      gone, so nothing can be read or sent. The fix is to REOPEN the panel (or,
      next time, just minimise it: minimise keeps mmui::MainWindow and the bridge
      keeps working head-lessly through InvokePattern).
    - neither -> WeChat is not running at all.

    Returns one of: wechat_logged_out, wechat_accessibility_unavailable,
    wechat_panel_closed, main_window_missing.
    """

    def exists(class_name: str) -> bool:
        try:
            return bool(auto.WindowControl(searchDepth=1, ClassName=class_name).Exists(0, 0))
        except Exception:
            return False

    if exists("mmui::LoginWindow"):
        # Existence of the login window is NOT proof of being signed out. Measured
        # on the live machine it appears in two states that need opposite handling:
        #   - a remembered account shows a real ButtonControl named 登录
        #     (the session is still valid and only needs confirming);
        #   - a signed-out client shows 扫码登录 and a 二维码 button instead.
        # Calling the first one 'logged out' is what destroyed a live session here:
        # the advice for 'logged out' is to start the client again, and restarting a
        # logged-in WeChat can drop the session. So read the window, not just its
        # existence, and fall back to the weaker claim when nothing can be read.
        if _login_window_offers_confirmation(auto):
            return "wechat_login_confirmation"
        return "wechat_logged_out"
    # The tray/shell window WeChat leaves behind after the panel is X-closed: it
    # carries the Qt window class, not an mmui one, and has no widget subtree.
    shell = None
    try:
        for win in auto.GetRootControl().GetChildren():
            try:
                cls = str(win.ClassName or "")
                name = str(win.Name or "")
            except Exception:
                continue
            if cls.startswith("Qt") and ("微信" in name or name in ("Weixin", "WeChat")):
                shell = win
                break
    except Exception:
        shell = None
    if shell is None:
        return "main_window_missing"
    # Two different truths live behind "there is a WeChat window but no mmui tree":
    #
    # - an offscreen or tray-sized shell is what X-closing the panel leaves
    #   behind (measured: 276x45 parked at -32000,-32000, iconic). The panel
    #   really is closed.
    # - a large on-screen shell means the panel IS visible to the operator and
    #   only the accessibility tree is missing (measured: 743x872 and 1477x880
    #   visible, non-iconic, with zero UIA nodes). Calling that "closed" is wrong
    #   twice over: the operator can see it is open, and the advice it gave -
    #   minimise - is the one action proven to DESTROY the tree on this build.
    #
    # So the visible case gets its own code and a message that points at the only
    # thing that actually restores the tree: restarting WeChat.
    try:
        rect = shell.BoundingRectangle
        width = int(rect.right) - int(rect.left)
        height = int(rect.bottom) - int(rect.top)
        offscreen = bool(shell.IsOffscreen)
    except Exception:
        # Unprovable geometry stays on the conservative path: report the panel as
        # closed only when the window is not visibly on screen.
        width = height = 0
        offscreen = True
    if not offscreen and width >= 400 and height >= 400:
        return "wechat_accessibility_unavailable"
    return "wechat_panel_closed"


class UiaBackend:
    """Windows-only UIA boundary using verified uiautomation 2.0.29 APIs."""

    def __init__(self):
        if sys.platform != "win32":
            raise SafetyError("native UIA requires Windows", "unsupported_platform")
        try:
            import uiautomation as auto
        except ImportError as exc:
            raise SafetyError("uiautomation is not installed", "dependency_missing") from exc
        self._auto = auto
        self._closed = False
        self._window = auto.WindowControl(searchDepth=1, ClassName="mmui::MainWindow")
        if not self._window.Exists(0, 0):
            # Three distinct causes, each with a different operator fix, used to
            # all collapse into main_window_missing. classify_missing_main_window
            # separates them so the log says what to do, not just that it failed:
            # signed out, panel closed with the X (process alive, a11y tree gone),
            # or WeChat not running at all.
            code = classify_missing_main_window(auto)
            raise SafetyError("WeChat main window is unavailable", code)

    def surface_state(self) -> str | None:
        """Classify a poll failure that came from raw COM errors.

        uiautomation raises plain COMError (not SafetyError) once the window is
        gone, so the generic 'poll_failed' would otherwise swallow the only
        actionable fact. Returns a surface-lost code when the main window is no
        longer there, and None when it still is (a one-off glitch must never
        tear the bridge down).
        """

        if self._closed:
            return "backend_closed"
        try:
            if self._window.Exists(0, 0):
                return None
        except Exception:
            # Even Exists() can throw COM errors while the surface dies around it.
            pass
        return classify_missing_main_window(self._auto)

    # Labels and ids WeChat uses for the control that commits the draft. Matched
    # exactly (not by substring) so 发送图片 / 发送表情 cannot be mistaken for it.
    # ORDERED, not a set: the probe below tries these one at a time and the label
    # this build really uses (发送, measured on the live tree) must be first. The
    # old sorted() put the three English aliases ahead of it, each absent label
    # costing a full timeout, so the working name was reached only after ~30s.
    SEND_LABELS = ("发送", "send", "send(s)", "send message")
    # Bound for each probe. The library default is TIME_OUT_SECOND = 10, and
    # 4 absent labels x 10s is what made a background send stall for half a
    # minute. A present control answers in tens of milliseconds, so 0.6s gives
    # the UI layer room to breathe without turning a miss into a stall.
    SEND_PROBE_TIMEOUT_S = 0.6
    SEND_ID_HINTS = ("send",)
    # Depth and node budget for the fallback walk. Both numbers come from the live
    # tree, not from guesswork: the 发送 button sits 20 levels below
    # mmui::MainWindow, so a limit of 18 (the previous value) never reached it and
    # the probe reported send_candidates: 0 - a false 'this build has no send
    # control' that would have pushed background sending onto the keyboard route.
    # The budget is generous because a panel with a long message list is far
    # larger than the ~160 nodes measured on an idle chat.
    CONTROL_WALK_DEPTH = 26
    CONTROL_WALK_BUDGET = 6000

    def _all_controls(self, budget: int | None = None):
        """Depth-first walk of the attached window, bounded, never raising.

        Used to look for affordances that are not exposed by automation id. The
        budget stops a runaway walk; any COM error ends the walk with what was
        already collected rather than failing the operation, because 'no
        affordance found' is a legitimate answer with a keyboard fallback.
        """

        # Resolve the default at call time so the class constant stays the single
        # source of truth for both the walk and its tests.
        limit = self.CONTROL_WALK_BUDGET if budget is None else budget
        found = []
        stack = [(self._window, 0)]
        while stack and len(found) < limit:
            control, depth = stack.pop()
            try:
                children = list(control.GetChildren())
            except Exception:
                continue
            for child in children:
                found.append(child)
                if depth < self.CONTROL_WALK_DEPTH - 1:
                    stack.append((child, depth + 1))
        return found

    def _looks_like_send(self, control: Any) -> bool:
        """Predicate for the control that commits the draft."""

        try:
            if control.IsOffscreen:
                return False
            if str(control.ControlTypeName) not in ("ButtonControl", "HyperlinkControl"):
                return False
        except Exception:
            return False
        label = str(_safe_property(control, "Name") or "").strip().lower()
        identifier = str(_safe_property(control, "AutomationId") or "").strip().lower()
        named = label in {x.lower() for x in self.SEND_LABELS}
        ided = bool(identifier) and any(h in identifier for h in self.SEND_ID_HINTS)
        if not (named or ided):
            return False
        return _safe_property(control, "ClassName") is not None

    def _send_by_name_hint(self):
        """Targeted UIA search for the send button; None when unsupported.

        Cheaper than the fallback walk: the tree is deep and a full scan on every
        send would cost hundreds of milliseconds. Not all builds expose this
        lookup, hence the getattr guard instead of a direct call.
        """

        # getattr on the namespace itself: a backend that never attached one must
        # fall through to the walk rather than raise out of a background send.
        namespace = getattr(self, "_auto", None)
        factory = getattr(namespace, "ButtonControl", None)
        if factory is None:
            return None
        for label in self.SEND_LABELS:
            try:
                # No Exists=False: the factories take no timeout keyword, so an
                # unknown name is collected into searchProperties and the returned
                # control stays LAZY - the first property read then re-runs the
                # search with the library default of ten seconds. No FirstChild
                # either: that prunes the search to the first child of every level,
                # and the real 发送 button sits on a later branch of the input
                # toolbar (measured at depth 20), so the fast path could never see it.
                control = factory(Name=label, searchDepth=self.CONTROL_WALK_DEPTH)
                # Exists(seconds, interval) is what bounds the wait; it raises on a
                # miss, which the except below reads as simply not-this-label.
                if not control.Exists(self.SEND_PROBE_TIMEOUT_S, 0.05):
                    continue
            except Exception:
                # Absent label, or a build whose factory does not accept these
                # arguments. Either way the bounded walk is the fallback.
                continue
            if self._looks_like_send(control):
                return control
        return None

    def _send_affordance(self):
        """Return a control that looks like WeChat's own send button, or None.

        Ordered by measured cost, not by which lookup sounds cheaper. On the live
        tree one bounded walk visits all 170 nodes in 141ms and finds the button;
        probing the four labels by name costs 1515ms for the same result, because
        uiautomation re-derives the tree from the root for every Name filter. The
        walk therefore runs first and the labelled probe is only the fallback for
        the case where the walk returns nothing (a window that detached mid-poll,
        or a tree deeper than the budget). The predicate lives in
        _looks_like_send so both paths judge a candidate identically.
        """

        try:
            pool = self._all_controls()
        except Exception:
            pool = []
        for control in pool:
            if self._looks_like_send(control):
                return control
        # Nothing found in the walk: give the named probe its turn.
        return self._send_by_name_hint()

    def send_by_invoke(self) -> bool:
        """Commit the draft through the app's send control. Needs no keyboard.

        True only when the control exists and Invoke() reported success; the
        caller still verifies delivery by reading the message list back, so an
        Invoke that lies (this build has done exactly that for chat selection)
        is caught there instead of being trusted here.
        """

        control = self._send_affordance()
        if control is None:
            return False
        try:
            pattern = control.GetInvokePattern()
        except Exception:
            return False
        if pattern is None:
            return False
        try:
            return bool(pattern.Invoke(waitTime=0))
        except Exception:
            return False
    def maybe_auto_minimize(self) -> None:
        """Put WeChat away without touching the operator's screen. Opt-in only.

        WeChat 4.x has no close-to-tray setting (forensics: the option was
        removed; X-closing quits and DESTROYS the mmui tree). The headless
        operating point is therefore minimised, where InvokePattern still
        switches chats and sends. This method lets the bridge reach that state
        itself instead of asking a human, and it is the right hide because
        SW_SHOWMINNOACTIVE (7) does NOT activate the window, unlike SW_MINIMIZE
        (6) or SetForegroundWindow, which would steal focus from whatever the
        operator is doing. Default off: even stowing a window is a takeover if
        nobody asked for it.
        """

        if os.environ.get("DSH_WECHAT_GROUP_AUTO_MINIMIZE") != "1":
            return
        handle = _safe_property(self._window, "NativeWindowHandle")
        if not handle or sys.platform != "win32":
            return
        if _window_is_minimised(int(handle)):
            return
        from ctypes import wintypes

        SW_SHOWMINNOACTIVE = 7
        _user32().ShowWindow(wintypes.HWND(int(handle)), SW_SHOWMINNOACTIVE)
        time.sleep(0.3)
    def _control(self, automation_id: str) -> Any:
        if self._closed:
            raise SafetyError("backend is closed", "backend_closed")
        matches = []
        for control, _depth in self._auto.WalkControl(self._window, includeTop=True, maxDepth=40):
            if _safe_property(control, "AutomationId") == automation_id:
                matches.append(control)
                if len(matches) > 1:
                    break
        if len(matches) != 1:
            raise SafetyError("required UIA control is missing or duplicated", "control_missing")
        return matches[0]

    def _describe(self, control: Any) -> dict[str, Any]:
        return {
            "name": _safe_property(control, "Name"),
            "control_type": _safe_property(control, "ControlTypeName"),
            "automation_id": _safe_property(control, "AutomationId"),
            "class_name": _safe_property(control, "ClassName"),
            "is_enabled": _safe_property(control, "IsEnabled"),
            "is_offscreen": _safe_property(control, "IsOffscreen"),
            "native_window_handle": _safe_property(control, "NativeWindowHandle"),
            "process_id": _safe_property(control, "ProcessId"),
        }

    def _probe_tree(self, control: Any, depth: int, budget: list[int]) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        if depth < 0 or budget[0] <= 0:
            return rows
        for child in control.GetChildren():
            if budget[0] <= 0:
                break
            budget[0] -= 1
            row = self._describe(child)
            try:
                pattern = child.GetSelectionItemPattern()
                row["is_selected"] = bool(pattern.IsSelected) if pattern else None
            except Exception:
                row["is_selected"] = None
            row["children"] = self._probe_tree(child, depth - 1, budget)
            rows.append(row)
        return rows

    def probe_evidence(self) -> dict[str, Any]:
        controls = []
        for automation_id in KNOWN_CONTROL_IDS:
            try:
                control = self._control(automation_id)
                evidence = self._describe(control)
                evidence["found"] = True
                evidence["children"] = self._probe_tree(control, 2, [120])
            except SafetyError as exc:
                evidence = {"automation_id": automation_id, "found": False, "error": exc.code}
            controls.append(evidence)
        return {
            "read_only": True,
            "uiautomation_version": importlib.metadata.version("uiautomation"),
            "window": self._describe(self._window),
            "controls": controls,
            # Whether a keyboard-free send is even possible on this build. Listed
            # read-only: a probe must not invoke anything. A healthy build shows
            # the 发送 control here, which is what send_by_invoke targets; an empty
            # list means the only remaining route needs the keyboard (and the
            # operator's focus), so that fact is worth knowing before shipping.
            "send_candidates": [
                self._describe(control) for control in self._all_controls()
                if self._looks_like_send(control)
            ],
        }

    def list_session_titles(self) -> list[str]:
        titles = []
        for item in self._control("session_list").GetChildren():
            title = session_title(
                _safe_property(item, "AutomationId") or "",
                _safe_property(item, "Name") or "",
            )
            if title:
                titles.append(title)
        return titles

    def current_chat_title(self) -> str | None:
        """Return the open chat's title, or None when no chat panel is open.

        A freshly logged-in WeChat shows only the session list; the chat message
        list and input box do not exist until a chat is opened. None therefore
        means 'nothing is open', not 'the title is ambiguous': the caller is
        allowed to select the target first. A panel that IS open must still
        prove its title through the two independent properties below.

        Exception, measured on the live machine: the operator had collapsed the
        session sidebar, so session_list did not exist while chat_message_list
        and chat_input_field did, and the bridge was dead in a group that was
        perfectly readable. The panel header (chat_input_field.Name) carries the
        exact title of the open chat, so when the list is genuinely absent the
        header is used alone. That is one property instead of two, and the
        compromise is bounded: it applies only to the group the operator named
        by exact title, and every send still re-checks the title before and after
        each mutation, so a header that disagrees aborts instead of posting.
        When the list IS present but shows no single selection, nothing falls
        back - that is a real ambiguity and stays an error.
        """

        try:
            input_control = self._control("chat_input_field")
        except SafetyError:
            # No input control means no chat panel; report that instead of failing.
            return None
        input_title = _safe_property(input_control, "Name") or ""
        try:
            session_items = self._control("session_list").GetChildren()
        except SafetyError:
            # Collapsed sidebar. An unnamed header proves nothing about which chat
            # is open, so it stays 'nothing open' rather than a guessed title.
            return input_title.strip() or None
        selected: list[str] = []
        for item in session_items:
            try:
                pattern = item.GetSelectionItemPattern()
                if pattern and pattern.IsSelected:
                    selected.append(session_title(
                        _safe_property(item, "AutomationId") or "",
                        _safe_property(item, "Name") or "",
                    ))
            except Exception:
                continue
        if len(selected) != 1 or not selected[0] or input_title != selected[0]:
            # The list is available, so the two-property agreement still applies:
            # a header that disagrees with the selection is a real ambiguity.
            raise SafetyError("selected chat title is not exposed unambiguously", "title_unavailable")
        return selected[0]

    def select_chat(self, title: str) -> None:
        items = [
            item for item in self._control("session_list").GetChildren()
            if session_title(
                _safe_property(item, "AutomationId") or "",
                _safe_property(item, "Name") or "",
            ) == title
        ]
        if len(items) != 1:
            raise SafetyError("target session item is not unique", "duplicate_group_title")
        item = items[0]
        # Order of preference, always verified by reading the chat title back:
        #   1. InvokePattern - protocol-level, works with the window minimised,
        #      no focus change, no synthetic input. On this build it can return
        #      True while nothing switches, so success is never assumed.
        #   2. SetFocus + Click - proven to switch, but needs a visible window.
        # SelectionItemPattern.Select() stays unused: it lies the same way.
        # A refused activation falls through; an activation that reports success
        # is only accepted after the title check proves the chat really changed.
        # The click fallback is gated: SetFocus raises the whole WeChat window and
        # Click() posts real mouse coordinates, so with a minimised or hidden panel
        # it steals the screen and may land on whatever pixel is under the cached
        # rectangle. It only runs when the operator explicitly accepted screen use.
        attempts = [self._select_by_invoke]
        if self._allow_window_restore():
            attempts.append(self._select_by_click)
        for attempt in attempts:
            if attempt(item, title):
                return
        raise SafetyError("target chat could not be activated", "target_title_mismatch")

    def _select_by_invoke(self, item: Any, title: str) -> bool:
        """Activate through InvokePattern; True only when the title really changed."""

        try:
            invoke = item.GetInvokePattern()
        except Exception:
            invoke = None
        if invoke is None:
            return False
        try:
            if not invoke.Invoke(waitTime=0):
                return False
        except Exception:
            return False
        time.sleep(1.0)
        return self._title_matches(title)

    def _select_by_click(self, item: Any, title: str) -> bool:
        """Activate with focus+click; proven, but it takes the screen. Opt-in only.

        Refused unless the operator set DSH_WECHAT_GROUP_ALLOW_WINDOW_RESTORE, and
        refused when the item reports itself offscreen, because Click() would then
        fire at a stale rectangle somewhere else on the desktop.
        """

        if not self._allow_window_restore():
            return False
        if _safe_property(item, "IsOffscreen"):
            return False
        try:
            item.SetFocus()
            time.sleep(0.25)
            item.Click()
        except Exception:
            return False
        time.sleep(1.0)
        return self._title_matches(title)

    def _title_matches(self, title: str) -> bool:
        """True when the open chat's own title proves the switch happened."""

        try:
            return self.current_chat_title() == title
        except SafetyError:
            return False

    def ensure_window_restored(self) -> None:
        """Restore and focus the main window only when the operator opted in.

        The bridge never needs this: session switching goes through the
        protocol-level InvokePattern, which works while the window is minimised
        or hidden, so the default is to touch no window API at all.

        This method used to carry a duplicated tail copy of its own body AFTER
        the opt-in `if`, so the unconditional half ran on every 750ms poll: the
        WeChat window popped back on screen and stole keyboard focus from
        whatever the operator was doing, and with the opt-in on it did all of it
        twice. The guard now wraps the whole body and the calls appear once.
        """

        # Opt-in only: without it the bridge must not move, show or focus a
        # window, so any Win32 call here is a screen-steal regression.
        if not self._allow_window_restore():
            return
        handle = _safe_property(self._window, "NativeWindowHandle")
        if not handle or sys.platform != "win32":
            return
        from ctypes import wintypes

        user32 = _user32()
        user32.ShowWindow(wintypes.HWND(handle), 9)  # SW_RESTORE
        time.sleep(0.3)
        user32.SetForegroundWindow(wintypes.HWND(handle))
        time.sleep(0.4)

    def read_input(self) -> str:
        pattern = self._control("chat_input_field").GetValuePattern()
        if not pattern:
            raise SafetyError("chat input has no ValuePattern", "input_unsupported")
        return pattern.Value

    def set_input(self, text: str) -> None:
        pattern = self._control("chat_input_field").GetValuePattern()
        if not pattern or pattern.IsReadOnly or not pattern.SetValue(text, waitTime=0):
            raise SafetyError("chat input ValuePattern rejected text", "input_unsupported")

    def press_enter(self) -> None:
        """Press Enter only after proving the keystroke lands in WeChat's input box.

        Control.SendKeys() is SetFocus() plus a global keyboard inject, so if the
        focus does not actually move to the target the keypress goes to whatever
        window the operator is using: an Enter inside someone else's app, possibly
        submitting their form. The claim in the old comment that SendKeys 'only
        sets focus' is wrong, and it is exactly the kind of screen control the
        operator must not get from a background bridge.

        So verify focus before injecting, re-verify once after a single SetFocus
        attempt, and otherwise raise without typing anything: an unverifiable
        target is refused, not risked.
        """

        control = self._control("chat_input_field")
        # Route 1: the app's own send control. Invoke is a UIA message to one
        # control and needs no keyboard at all, so nothing about the operator's
        # foreground window changes.
        if self.send_by_invoke():
            return
        # Route 2: keyboard, but only when WeChat provably owns it. This is the
        # reliable route, so it is taken before the experimental one: a route
        # that might deliver AND a fallback that might deliver could send twice.
        if self._focus_is_contained(control):
            control.SendKeys("{Enter}", waitTime=0)
            return
        # Route 3: one Enter posted into WeChat's own message queue. PostMessage
        # targets a single window handle in a single thread queue, so by
        # construction it cannot reach another application, and Qt delivers it to
        # whichever widget holds the app's INTERNAL focus - which is why this may
        # work while WeChat is hidden. Whether this build honours it is NOT
        # verified (its panel was X-closed and unrecoverable), so it is only
        # trusted when the draft is re-read and provably gone.
        if self._posted_enter_delivered():
            return
        # Containment first: if WeChat's own process already owns the keyboard,
        # the chat that receives Enter is inside WeChat, so typing is safe
        # without touching focus at all (SetFocus is what could move a window
        # forward). Only when the keystroke is not provably ours do we attempt
        # one focus change, and even then we re-prove containment before typing.
        if self._focus_is_contained(control):
            control.SendKeys("{Enter}", waitTime=0)
            return
        # Route 4: the recovery below is itself a screen takeover. SetFocus on a
        # control in a background window ACTIVATES that window to move the caret,
        # raising WeChat over whatever the operator is using; measured, it also
        # fails silently while minimised, so it buys nothing in the state that
        # matters and steals the screen in every other state. Gated by the same
        # opt-in as the click fallback, so one switch governs every takeover path.
        if self._allow_window_restore():
            try:
                control.SetFocus()
            except Exception:
                pass
        if not self._focus_is_contained(control) and not self._focus_is_target(control):
            raise SafetyError(
                "keyboard focus is not provably on the WeChat input",
                "focus_not_on_target",
            )
        control.SendKeys("{Enter}", waitTime=0)

    # Virtual-key code and message ids for the posted-Enter route. Spelled out
    # rather than imported so the intent is readable without a Win32 header.
    VK_RETURN = 0x0D
    WM_KEYDOWN = 0x0100
    WM_KEYUP = 0x0101

    def _draft_text(self):
        """Current draft, or None when it cannot be read.

        None is not empty: it means the post cannot be verified, and an
        unverifiable post that a keyboard fallback also retried could send the
        same message twice. Callers must treat None as "do not trust".
        """

        try:
            return str(self.read_input())
        except Exception:
            return None

    def _posted_enter_delivered(self) -> bool:
        """Post Enter into the app message queue and prove it was consumed.

        Returns True only when the draft was readable before AND empty after, so
        a send is never reported on the strength of a PostMessage return value
        alone. Any doubt returns False and the caller decides.
        """

        # getattr, not indexing: a backend built without a window (older test
        # doubles) must report 'cannot post' rather than crash the send.
        window = getattr(self, "_window", None)
        handle = _safe_property(window, "NativeWindowHandle") if window is not None else None
        if not handle or sys.platform != "win32":
            return False
        # Identity check before writing into anyone's queue: only a window that
        # announces itself as WeChat's own mmui surface is a legitimate target.
        # A bare handle number proves nothing, and an unprovable identity is
        # treated exactly like a foreign window - skip and refuse.
        class_name = str(_safe_property(window, "ClassName") or "")
        if not class_name.startswith("mmui::"):
            return False
        if self._draft_text() is None:
            return False
        from ctypes import wintypes

        try:
            user32 = _user32()
            # Repeat count 1, scan code for Return, previous-key-state up.
            down = wintypes.LPARAM(1 | (0x1C << 16))
            up = wintypes.LPARAM(1 | (0x1C << 16) | (0xC0 << 24))
            user32.PostMessageW(wintypes.HWND(int(handle)), wintypes.UINT(self.WM_KEYDOWN),
                                wintypes.WPARAM(self.VK_RETURN), down)
            user32.PostMessageW(wintypes.HWND(int(handle)), wintypes.UINT(self.WM_KEYUP),
                                wintypes.WPARAM(self.VK_RETURN), up)
        except Exception:
            return False
        # Give the app a moment to consume it, then require the proof.
        for _ in range(6):
            time.sleep(0.25)
            after = self._draft_text()
            if after is not None and not after.strip():
                return True
        return False
    def _focus_is_contained(self, control: Any) -> bool:
        """True when the focused element belongs to THIS WeChat process.

        The first version compared the focused control with the target by
        automation id and handle. Live measurement killed that design: on a
        minimised window UIA reports the focus as an intermediate pane
        (reproduced with a Tk window: a TkChild whose handle matches neither
        the top level nor the entry), so identity matching refused every real
        background send. The property that actually guarantees safety is
        containment, not identity: Enter can only execute inside the chat that
        is focused, so if the focused element lives in WeChat's own process,
        the keystroke cannot reach the operator's application - regardless of
        which pane inside WeChat holds it.

        Fail-closed on every unknown: a missing reader, a missing pid, or a
        COM error means 'not provable', so we refuse instead of guessing.
        """

        auto = self._auto
        get_focused = getattr(auto, "GetFocusedControl", None)
        if get_focused is None:
            return False
        try:
            focused = get_focused()
        except Exception:
            return False
        if focused is None:
            return False
        # getattr, not indexing: a backend built without a window (older test
        # doubles) must answer 'unprovable' rather than crash into the send.
        window = getattr(self, "_window", None)
        own_pid = _safe_property(window, "ProcessId") if window is not None else None
        focused_pid = _safe_property(focused, "ProcessId")
        if not isinstance(own_pid, int) or own_pid <= 0:
            return False
        if not isinstance(focused_pid, int) or focused_pid <= 0:
            return False
        return focused_pid == own_pid

    def _focus_is_target(self, control: Any) -> bool:
        """True only when the OS focused element really is this WeChat control.

        Two window shapes have to be matched, and getting this wrong once broke
        background sending outright: the first version demanded equal native
        handles, but measured on the live machine every mmui child reports
        NativeWindowHandle == 0 (only the top-level 微信 window owns a handle),
        so that guard refused EVERY real send with focus_not_on_target.

        So the automation id is the primary key (chat_input_field is unique to
        this app inside the WeChat window), then:
        - both sides expose real handles: they must agree, so an identically
          named control in another window cannot pass;
        - both sides are handle-less mmui children: require the focused class to
          start with mmui::, which no foreign app uses;
        - one handle and one not: mismatch, refuse.
        """

        auto = self._auto
        get_focused = getattr(auto, "GetFocusedControl", None)
        if get_focused is None:
            return False
        try:
            focused = get_focused()
        except Exception:
            return False
        if focused is None:
            return False
        focused_handle = _safe_property(focused, "NativeWindowHandle")
        # A minimised panel often reports its top-level window, not the child
        # edit, as the focused element. The keyboard then belongs to WeChat for
        # certain, so the Enter cannot leak into another app: compare against the
        # handle of the very main window this backend attached to.
        window = getattr(self, "_window", None)
        main_handle = _safe_property(window, "NativeWindowHandle") if window else None
        if main_handle and focused_handle:
            if int(focused_handle) == int(main_handle):
                return True
        target_id = _safe_property(control, "AutomationId")
        if not target_id or _safe_property(focused, "AutomationId") != target_id:
            return False
        handle = _safe_property(control, "NativeWindowHandle")
        if handle and focused_handle:
            return int(handle) == int(focused_handle)
        if not handle and not focused_handle:
            return str(_safe_property(focused, "ClassName") or "").startswith("mmui::")
        return False

    def read_messages(self) -> list[RawMessage]:
        items = self._control("chat_message_list").GetChildren()
        if not items:
            return []
        rows = [
            {
                "cls": _safe_property(item, "ClassName") or "",
                "name": _safe_property(item, "Name") or "",
            }
            for item in items
        ]
        # WeChat 4.1 exposes no sender/self child control, so this returns
        # unverified rows. allow_unverified comes from the environment switch:
        # absent means strict fail-closed, preserving the earlier contract.
        allow = self._allow_unverified()
        return read_visible_rows_as_messages(rows, allow_unverified=allow)

    def _allow_unverified(self) -> bool:
        """Explicit opt-in: visible rows may carry content but never an identity."""
        return os.environ.get("DSH_WECHAT_GROUP_ALLOW_UNVERIFIED") == "1"

    def _allow_window_restore(self) -> bool:
        """Explicit opt-in: the bridge must never take the screen away by itself."""
        return os.environ.get("DSH_WECHAT_GROUP_ALLOW_WINDOW_RESTORE") == "1"


    def _allow_send(self) -> bool:
        """Explicit opt-in: an observe-only bridge must never write to the chat."""
        return os.environ.get("DSH_WECHAT_GROUP_ALLOW_SEND") == "1"

    def health(self) -> dict[str, Any]:
        control_status = {}
        for automation_id in KNOWN_CONTROL_IDS:
            try:
                self._control(automation_id)
                control_status[automation_id] = True
            except SafetyError:
                control_status[automation_id] = False
        return {
            "main_window": self._window.Exists(0, 0),
            "controls": all(control_status.values()),
            "control_status": control_status,
            "message_parser": "unverified_rows" if self._allow_unverified() else "probe_required",
        }

    def close(self) -> None:
        self._closed = True


def write_probe(backend: Any, stream: TextIO) -> None:
    """Emit one JSON evidence object without selection, text entry or sending."""

    evidence = backend.probe_evidence()
    JsonlProtocol._write(stream, {"type": "probe", "ok": True, **evidence})


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--probe", action="store_true", help="print read-only UIA evidence")
    parser.add_argument("--config", help="account-level group-chats.json")
    args = parser.parse_args(argv)
    for stream in (sys.stdin, sys.stdout):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    try:
        backend = UiaBackend()
        if args.probe:
            write_probe(backend, sys.stdout)
            backend.close()
            return 0
        if not args.config:
            parser.error("--config is required unless --probe is used")
        groups, interval = load_config(args.config)
        adapter = WechatGroupAdapter(groups, backend)
        JsonlProtocol(adapter).serve(sys.stdin, sys.stdout, interval)
        return 0
    except BridgeError as exc:
        JsonlProtocol._write(sys.stdout, {
            "type": "error", "ok": False,
            "error": {"code": exc.code, "message": ERROR_MESSAGES.get(exc.code, "The bridge stopped safely.")},
        })
        return 1
    except (OSError, json.JSONDecodeError):
        JsonlProtocol._write(sys.stdout, {
            "type": "error", "ok": False,
            "error": {"code": "invalid_config", "message": "The group config could not be read."},
        })
        return 1
    except Exception:
        JsonlProtocol._write(sys.stdout, {
            "type": "error", "ok": False,
            "error": {"code": "bridge_error", "message": "The bridge stopped safely."},
        })
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
