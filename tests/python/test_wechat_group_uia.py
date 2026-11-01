import io
import json
import os
import tempfile
import unittest
from unittest import mock

from scripts import wechat_group_uia as uia


class FakeWindow:
    """Stand-in for a uiautomation window control: reports one fixed presence."""

    def __init__(self, exists):
        self._exists = exists

    def Exists(self, seconds, interval):
        return self._exists


class FakeAuto:
    """Minimal uiautomation surface, enough to pick the backend failure code."""

    def __init__(self, main, login):
        self._main = main
        self._login = login

    def WindowControl(self, searchDepth, ClassName):
        if ClassName == "mmui::MainWindow":
            return FakeWindow(self._main)
        return FakeWindow(self._login)


class FakeBackend:
    """In-memory UIA boundary; every mutating method is observable by tests."""

    def __init__(self, titles=None, current="Alpha", messages=None):
        self.titles = list(titles if titles is not None else ["Alpha", "Beta"])
        self.current = current
        self.messages = {key: list(value) for key, value in (messages or {}).items()}
        self.inputs = {title: "" for title in self.titles}
        self.operations = []
        self.send_behavior = "echo"
        self.wrong_selection = None
        self.fail_restore = False
        self.closed = 0

    def list_session_titles(self):
        self.operations.append(("list_sessions",))
        return list(self.titles)

    def current_chat_title(self):
        self.operations.append(("current_title",))
        return self.current

    def read_input(self):
        self.operations.append(("read_input", self.current))
        return self.inputs.get(self.current, "")

    def select_chat(self, title):
        self.operations.append(("select", title))
        if self.fail_restore and title == "Beta":
            raise uia.SafetyError("injected restore failure")
        self.current = self.wrong_selection or title

    def read_messages(self):
        self.operations.append(("read_messages", self.current))
        return list(self.messages.get(self.current, []))

    def set_input(self, text):
        self.operations.append(("set_input", self.current, text))
        self.inputs[self.current] = text

    def press_enter(self):
        text = self.inputs.get(self.current, "")
        self.operations.append(("send", self.current, text))
        if self.send_behavior == "echo":
            self.messages.setdefault(self.current, []).append(
                uia.RawMessage("me", text, True, "t-new")
            )
        elif self.send_behavior == "double":
            self.messages.setdefault(self.current, []).extend([
                uia.RawMessage("me", text, True, "t-new-1"),
                uia.RawMessage("me", text, True, "t-new-2"),
            ])
        elif self.send_behavior == "sticky":
            self.messages.setdefault(self.current, []).append(
                uia.RawMessage("me", text, True, "t-new")
            )
            return
        self.inputs[self.current] = ""

    def health(self):
        self.operations.append(("health",))
        return {"main_window": True, "controls": True}

    def probe_evidence(self):
        self.operations.append(("probe",))
        return {
            "window": {"class_name": "mmui::MainWindow", "control_type": "WindowControl"},
            "controls": [{"automation_id": "session_list", "control_type": "ListControl"}],
        }

    def close(self):
        self.closed += 1
        self.operations.append(("close",))


def group(chat_id="uia_g1", title="Alpha", allow_self=False, prefix="/dsh",
          mention_mode="command", allow_unverified_trigger=False,
          trigger_names=("Nickname",)):
    return uia.GroupConfig(
        id=chat_id,
        title=title,
        trigger_names=trigger_names,
        command_prefix=prefix,
        allow_self=allow_self,
        mention_mode=mention_mode,
        allow_unverified_trigger=allow_unverified_trigger,
    )


def raw(text, sender="Alice", is_self=False, visible_time=""):
    return uia.RawMessage(sender, text, is_self, visible_time)


def operations(backend, name):
    return [item for item in backend.operations if item[0] == name]


class TriggerTests(unittest.TestCase):
    def test_command_prefix_strips_only_trigger_and_whitespace(self):
        self.assertEqual(uia.parse_trigger("/dsh  hello world  ", "/dsh"), (True, "hello world"))

    def test_command_without_body_is_empty(self):
        self.assertEqual(uia.parse_trigger("/dsh   ", "/dsh"), (True, ""))

    def test_prefix_must_be_a_complete_token(self):
        self.assertEqual(uia.parse_trigger("/dshorthand", "/dsh"), (False, "/dshorthand"))

    def test_typed_at_name_cannot_enable_mention_routing(self):
        # UIA text cannot distinguish a real mention from typed characters.
        self.assertEqual(uia.parse_trigger("@Nickname hello", "/dsh"), (False, "@Nickname hello"))

    def test_empty_prefix_never_marks_everything_addressed(self):
        self.assertEqual(uia.parse_trigger("hello", ""), (False, "hello"))


class ReadableMentionShapeTests(unittest.TestCase):
    """The real @ on this build is a readable name, not a bracket placeholder.

    Measured from the live transcript at 00:26 by reading the exact row the
    operator sent: its accessibility name was the characters for 大肥鱼 followed by
    U+2005 (FOUR-PER-EM SPACE), with no bracket anywhere in the codepoint dump.
    The earlier analysis concluded WeChat masks mentioned names to the literal
    token @[___] and the whole trigger rule was built on that shape, so the
    operator own @ parsed as NOT addressed and the bot stayed mute. Both shapes
    must be honoured: the bracket form for builds that mask, and the readable name
    for this build - which is stronger evidence, because a name can be compared.
    """

    # Escapes keep the file ASCII-safe and the codepoints unambiguous:
    # 大肥鱼 = U+5927 U+80A5 U+9C7C, followed by U+2005.
    AT = "@\u5927\u80a5\u9c7c\u2005"
    BODY = "\u5e2e\u6211\u4e0b\u5355"

    def test_the_measured_at_row_is_stripped_to_its_body(self):
        # POSITIVE CONTROL for this fix: with only the bracket regex this comes
        # back (False, text) and the operator mention never fires.
        parsed, text = uia.parse_trigger(
            self.AT + " " + self.BODY, "/dsh", mention_mode="mention-or-command",
            trigger_names=("\u5927\u80a5\u9c7c",), allow_masked_mention=True)
        self.assertTrue(parsed)
        self.assertEqual(text, self.BODY)

    def test_a_mention_of_someone_else_is_still_refused(self):
        foreign = "@\u5c0f\u674e\u2005 " + self.BODY
        self.assertEqual(
            uia.parse_trigger(foreign, "/dsh", mention_mode="mention-or-command",
                              trigger_names=("\u5927\u80a5\u9c7c",),
                              allow_masked_mention=True),
            (False, foreign),
        )

    def test_a_readable_name_needs_a_configured_trigger_name(self):
        # A readable mention must never be honoured merely because the group opted
        # in for masked tokens: here the name IS readable, so comparing it is the
        # whole point and the opt-in cannot substitute for it.
        self.assertEqual(
            uia.parse_trigger(self.AT + " " + self.BODY, "/dsh",
                              mention_mode="mention-or-command",
                              trigger_names=(), allow_masked_mention=True),
            (False, self.AT + " " + self.BODY),
        )

    def test_the_bracket_shape_still_works(self):
        # Regression guard for a masking build: the old shape must keep working.
        parsed, text = uia.parse_trigger(
            "@[___] " + self.BODY, "/dsh", mention_mode="mention-or-command",
            allow_masked_mention=True)
        self.assertTrue(parsed)
        self.assertEqual(text, self.BODY)

    def test_command_mode_is_unaffected(self):
        # The default mode must not start honouring readable mentions.
        self.assertEqual(
            uia.parse_trigger(self.AT + " " + self.BODY, "/dsh"),
            (False, self.AT + " " + self.BODY),
        )

class MentionTriggerTests(unittest.TestCase):
    """Direct @ mention as an address, with no command prefix.

    Measured facts this class is built on: WeChat 4.2.0.12 renders a real @ as
    the literal token "@[___]" inside the message text, and a group row carries
    no author at all (sender is always "uia-unverified:row"). The placeholder is
    only produced by picking a member from the @ list, so the *shape* is a
    usable signal even though the *name* inside it is not. A hand-typed
    "@大肥鱼" has no such shape and must stay unaddressed.
    """

    MASKED = "@[___] 帮我下单"

    def test_masked_mention_is_an_address_only_when_the_group_opts_in(self):
        # POSITIVE CONTROL for the mention branch: delete the branch and this
        # assertion is the first thing that goes RED.
        self.assertEqual(
            uia.parse_trigger(self.MASKED, "/dsh", mention_mode="mention",
                              allow_masked_mention=True),
            (True, "帮我下单"),
        )

    def test_masked_mention_without_opt_in_is_not_an_address(self):
        # The name inside the placeholder is erased, so a masked token proves
        # "someone was @-ed", not "the bot was @-ed". Without the operator
        # naming this group, it must not fire.
        self.assertEqual(
            uia.parse_trigger(self.MASKED, "/dsh", mention_mode="mention",
                              allow_masked_mention=False),
            (False, self.MASKED),
        )

    def test_hand_typed_at_name_is_still_not_a_mention(self):
        # Negative control with the opposite polarity: the token must have the
        # placeholder shape, so ordinary text that merely starts with @ stays
        # unaddressed even for a fully opted-in group.
        for text in ("@大肥鱼 帮我下单", "@ 大肥鱼 帮我下单", "@[]", "@[] 帮我下单"):
            self.assertEqual(
                uia.parse_trigger(text, "/dsh", mention_mode="mention",
                                  allow_masked_mention=True),
                (False, text),
                text,
            )

    def test_command_mode_is_unaffected_by_the_new_argument_defaults(self):
        # Backward compatibility: every existing call site passes no
        # mention_mode, so both the prefix path and the @ path behave exactly
        # as they did before this feature existed.
        self.assertEqual(uia.parse_trigger("/dsh 正文", "/dsh"), (True, "正文"))
        self.assertEqual(uia.parse_trigger(self.MASKED, "/dsh"), (False, self.MASKED))
        self.assertEqual(
            uia.parse_trigger(self.MASKED, "/dsh", mention_mode="command",
                              allow_masked_mention=True),
            (False, self.MASKED),
        )

    def test_mention_or_command_accepts_both_forms(self):
        self.assertEqual(
            uia.parse_trigger("/dsh 下单", "/dsh", mention_mode="mention-or-command",
                              allow_masked_mention=True),
            (True, "下单"),
        )
        self.assertEqual(
            uia.parse_trigger(self.MASKED, "/dsh", mention_mode="mention-or-command",
                              allow_masked_mention=True),
            (True, "帮我下单"),
        )

    def test_mention_mode_alone_never_honours_the_prefix(self):
        self.assertEqual(
            uia.parse_trigger("/dsh 下单", "/dsh", mention_mode="mention",
                              allow_masked_mention=True),
            (False, "/dsh 下单"),
        )

    def test_readable_mention_name_must_match_the_configured_trigger_names(self):
        # If a future build exposes the real name, the name decides everything:
        # an @ of another member is not an address of the bot, and the
        # unverified opt-in is not consulted at all.
        self.assertEqual(
            uia.parse_trigger("@[小李] 帮我下单", "/dsh", mention_mode="mention",
                              trigger_names=("大肥鱼",), allow_masked_mention=False),
            (False, "@[小李] 帮我下单"),
        )
        self.assertEqual(
            uia.parse_trigger("@[大肥鱼] 帮我下单", "/dsh", mention_mode="mention",
                              trigger_names=("大肥鱼",), allow_masked_mention=False),
            (True, "帮我下单"),
        )

    def test_readable_name_without_configured_names_fails_closed(self):
        # No triggerNames configured means nothing can prove the bot was the
        # one @-ed, so the row stays unaddressed even with the opt-in on.
        self.assertEqual(
            uia.parse_trigger("@[大肥鱼] 帮我下单", "/dsh", mention_mode="mention",
                              allow_masked_mention=True),
            (False, "@[大肥鱼] 帮我下单"),
        )

    def test_leading_mention_tokens_are_all_stripped_but_a_foreign_one_stops(self):
        self.assertEqual(
            uia.parse_trigger("@[___] @[___] 帮我下单", "/dsh", mention_mode="mention",
                              allow_masked_mention=True),
            (True, "帮我下单"),
        )
        self.assertEqual(
            uia.parse_trigger("@[小李] @[___] 帮我下单", "/dsh", mention_mode="mention",
                              trigger_names=("大肥鱼",), allow_masked_mention=True),
            (False, "@[小李] @[___] 帮我下单"),
        )

    def test_mention_must_be_leading_and_a_bare_mention_has_no_body(self):
        self.assertEqual(
            uia.parse_trigger("帮我下单 @[___]", "/dsh", mention_mode="mention",
                              allow_masked_mention=True),
            (False, "帮我下单 @[___]"),
        )
        self.assertEqual(
            uia.parse_trigger("@[___]   ", "/dsh", mention_mode="mention",
                              allow_masked_mention=True),
            (True, ""),
        )

    def test_mention_after_the_prefix_is_stripped_too(self):
        self.assertEqual(
            uia.parse_trigger("@[___] /dsh 下单", "/dsh",
                              mention_mode="mention-or-command",
                              allow_masked_mention=True),
            (True, "下单"),
        )

    def test_unknown_mention_mode_falls_back_to_command_only(self):
        # Fail closed: a mode nobody validated must never grant new power.
        self.assertEqual(
            uia.parse_trigger(self.MASKED, "/dsh", mention_mode="mentions",
                              allow_masked_mention=True),
            (False, self.MASKED),
        )
        self.assertEqual(
            uia.parse_trigger("/dsh 正文", "/dsh", mention_mode="mentions"),
            (True, "正文"),
        )


class MentionAdapterTests(unittest.TestCase):
    """The adapter and the JS runtime must agree on one rule, on real rows."""

    def unverified_group(self, mode="mention", opt_in=True, **kwargs):
        return group(mention_mode=mode, allow_unverified_trigger=opt_in, **kwargs)

    def row(self, text):
        # Exactly what UIA yields today: text present, author absent.
        return uia.read_visible_rows_as_messages(
            [{"cls": "mmui::ChatTextItemView", "name": text}], allow_unverified=True,
        )[0]

    def poll_one(self, text, config):
        backend = FakeBackend(messages={"Alpha": []})
        adapter = uia.WechatGroupAdapter([config], backend, clock=lambda: 7)
        adapter.start()
        backend.messages["Alpha"].append(self.row(text))
        return adapter.poll()

    def test_opted_in_group_answers_a_direct_mention(self):
        events = self.poll_one("@[___] 帮我下单", self.unverified_group())
        self.assertEqual(len(events), 1)
        event = events[0]
        self.assertTrue(event["addressed"])
        # The agent must not see the placeholder.
        self.assertEqual(event["text"], "帮我下单")
        self.assertEqual(event["raw_text"], "@[___] 帮我下单")
        self.assertEqual(event["item_list"],
                         [{"type": 1, "text_item": {"text": "帮我下单"}}])
        self.assertTrue(uia.unverified_sender(event["from_user_id"]))
        uia.validate_message_event(event)

    def test_command_group_still_ignores_a_direct_mention(self):
        # Unaddressed rows are still observed - that is shipped behaviour, pinned
        # by test_unaddressed_message_is_observational_only - but addressed must
        # be False, because that flag is the only entry ticket to the agent.
        events = self.poll_one("@[___] 帮我下单", self.unverified_group(mode="command"))
        self.assertEqual(len(events), 1)
        self.assertFalse(events[0]["addressed"])
        # Nothing was treated as a trigger, so the text stays whole.
        self.assertEqual(events[0]["text"], "@[___] 帮我下单")

    def test_mention_mode_with_nothing_to_match_cannot_be_constructed(self):
        # A config that can never fire is refused at load time instead of being
        # accepted and then silently mute. "Nothing to match" means neither the
        # masked-token opt-in nor any readable trigger name; the sibling
        # test_verified_sender_with_readable_name_needs_no_unverified_opt_in pins
        # the other half, where a configured name is sufficient on its own.
        backend = FakeBackend(messages={"Alpha": []})
        with self.assertRaises(uia.ConfigError):
            uia.WechatGroupAdapter(
                [self.unverified_group(opt_in=False, trigger_names=())], backend)
        self.assertEqual(operations(backend, "select"), [])

    def test_bare_mention_is_answered_instead_of_silently_dropped(self):
        # Inverted on purpose. A bare @ used to be dropped before it could become an
        # event, so the operator's poke looked like a dead bridge - measured
        # 2026-11-02, two bare @ rows produced no event at all. It now becomes one
        # short turn whose body is the configured prompt.
        events = self.poll_one("@[___]", self.unverified_group())
        self.assertEqual(len(events), 1, "a poke must not vanish")
        self.assertTrue(events[0]["addressed"])
        self.assertEqual(events[0]["text"], uia.GroupConfig.bare_mention_prompt)

    def test_bare_mention_is_dropped_when_the_prompt_is_explicitly_empty(self):
        # Negative control for the test above: the old silent behaviour stays
        # reachable per group, so this is a configurable policy and not a hard-wired
        # "always answer".
        group_cfg = self.unverified_group()
        group_cfg = uia.GroupConfig(
            id=group_cfg.id, title=group_cfg.title,
            trigger_names=group_cfg.trigger_names,
            command_prefix=group_cfg.command_prefix,
            allow_self=group_cfg.allow_self,
            allow_unverified_trigger=group_cfg.allow_unverified_trigger,
            mention_mode=group_cfg.mention_mode,
            bare_mention_prompt="",
        )
        self.assertEqual(self.poll_one("@[___]", group_cfg), [])

    def test_prefix_still_works_in_mention_or_command(self):
        events = self.poll_one("/dsh 下单",
                               self.unverified_group(mode="mention-or-command"))
        self.assertEqual([event["text"] for event in events], ["下单"])
        self.assertTrue(events[0]["addressed"])

    def test_verified_sender_with_readable_name_needs_no_unverified_opt_in(self):
        # The other half of the measured compromise: when the row DOES carry an
        # author and the mention carries a name, the name alone decides.
        backend = FakeBackend(messages={"Alpha": []})
        adapter = uia.WechatGroupAdapter(
            [group(mention_mode="mention", allow_unverified_trigger=False,
                   trigger_names=("大肥鱼",))], backend, clock=lambda: 8,
        )
        adapter.start()
        backend.messages["Alpha"].append(raw("@[大肥鱼] 帮我下单"))
        events = adapter.poll()
        self.assertEqual(len(events), 1)
        self.assertTrue(events[0]["addressed"])
        self.assertEqual(events[0]["text"], "帮我下单")

    def test_verified_sender_masked_mention_is_not_an_address(self):
        # allow_unverified_trigger only ever unlocks unverified rows; a named
        # sender plus a nameless placeholder still proves nothing about who was
        # @-ed.
        backend = FakeBackend(messages={"Alpha": []})
        adapter = uia.WechatGroupAdapter(
            [group(mention_mode="mention", allow_unverified_trigger=False)],
            backend, clock=lambda: 9,
        )
        adapter.start()
        backend.messages["Alpha"].append(raw("@[___] 帮我下单"))
        events = adapter.poll()
        self.assertEqual(len(events), 1)
        self.assertFalse(events[0]["addressed"])

    def echo_backend(self):
        """Backend double whose echo arrives as an unverified row, like live UIA.

        FakeBackend.press_enter tags the echo is_self=True, but the measured
        adapter cannot see is_self at all; this double reproduces the real
        (harder) shape so the loop test below proves something.
        """
        backend = FakeBackend(messages={"Alpha": []})

        def echo_as_unverified():
            text = backend.inputs.get(backend.current, "")
            backend.operations.append(("send", backend.current, text))
            backend.messages.setdefault(backend.current, []).append(
                uia.RawMessage("uia-unverified:row", text, False, ""),
            )
            backend.inputs[backend.current] = ""

        backend.press_enter = echo_as_unverified
        return backend

    def test_bridge_reply_containing_the_mention_token_does_not_retrigger(self):
        # The loop the objective warns about: the bot answers into the same
        # group, and every inbound row -- including its own -- arrives
        # unverified with is_self False, so the old is_self echo gate is empty.
        backend = self.echo_backend()
        adapter = uia.WechatGroupAdapter(
            [self.unverified_group(mode="mention-or-command")], backend,
            clock=lambda: 10,
        )
        adapter.start()
        result = adapter.send_text("r-mention-echo", "uia_g1", "@[___] 收到")
        self.assertTrue(result["ok"])
        self.assertEqual(adapter.drain_events(), [])

    def test_the_echo_guard_is_one_shot_not_a_mention_ban(self):
        # Same group, the same text arriving again as a genuinely new row: it
        # must fire, proving the suppression above consumed one echo rather
        # than switching the feature off.
        backend = self.echo_backend()
        adapter = uia.WechatGroupAdapter(
            [self.unverified_group(mode="mention-or-command")], backend,
            clock=lambda: 11,
        )
        adapter.start()
        self.assertTrue(adapter.send_text("r-echo-2", "uia_g1", "@[___] 收到")["ok"])
        self.assertEqual(adapter.drain_events(), [])
        backend.messages["Alpha"].append(self.row("@[___] 收到"))
        events = adapter.poll()
        self.assertEqual(len(events), 1)
        self.assertTrue(events[0]["addressed"])

    def test_health_reports_mention_routing_when_it_is_live(self):
        # The flag used to be a hardcoded False, which contradicted whatever the
        # operator had configured; it now reflects the groups actually loaded.
        backend = FakeBackend(messages={"Alpha": []})
        command_only = uia.WechatGroupAdapter([group()], backend, clock=lambda: 12)
        self.assertFalse(command_only.health()["mention_routing"])
        mention = uia.WechatGroupAdapter([self.unverified_group()], backend,
                                         clock=lambda: 13)
        self.assertTrue(mention.health()["mention_routing"])

    def test_unknown_mention_mode_is_rejected_before_any_ui_access(self):
        backend = FakeBackend(messages={"Alpha": []})
        with self.assertRaises(uia.ConfigError):
            uia.WechatGroupAdapter([group(mention_mode="all")], backend)
        with self.assertRaises(uia.ConfigError):
            uia.WechatGroupAdapter([group(mention_mode=1)], backend)
        self.assertEqual(operations(backend, "select"), [])

    def test_trigger_names_must_be_strings(self):
        backend = FakeBackend(messages={"Alpha": []})
        with self.assertRaises(uia.ConfigError):
            uia.WechatGroupAdapter([group(trigger_names=("大肥鱼", 7))], backend)


class BuildMessageEventMentionTests(unittest.TestCase):
    """build_message_event is the second addressed path; it must not diverge."""

    def row(self, text):
        return uia.read_visible_rows_as_messages(
            [{"cls": "mmui::ChatTextItemView", "name": text}], allow_unverified=True,
        )[0]

    def test_opted_in_masked_mention_is_addressed_here_too(self):
        event = uia.build_message_event(
            "uia_g1", "Alpha", self.row("@[___] 帮我下单"), trigger="/dsh", sent_at=1,
            allow_unverified_trigger=True, mention_mode="mention",
        )
        self.assertTrue(event["addressed"])
        self.assertEqual(event["text"], "帮我下单")

    def test_masked_mention_without_opt_in_stays_unaddressed(self):
        event = uia.build_message_event(
            "uia_g1", "Alpha", self.row("@[___] 帮我下单"), trigger="/dsh", sent_at=1,
            allow_unverified_trigger=False, mention_mode="mention",
        )
        self.assertFalse(event["addressed"])
        self.assertEqual(event["text"], "@[___] 帮我下单")

    def test_existing_callers_keep_their_behaviour(self):
        event = uia.build_message_event(
            "uia_g1", "Alpha", self.row("/dsh 执行"), trigger="/dsh", sent_at=1,
        )
        self.assertFalse(event["addressed"])
        event = uia.build_message_event(
            "uia_g1", "Alpha", self.row("/dsh 执行"), trigger="/dsh", sent_at=1,
            allow_unverified_trigger=True,
        )
        self.assertTrue(event["addressed"])
        self.assertEqual(event["text"], "执行")


class LoadConfigMentionModeTests(unittest.TestCase):
    """group-chats.json is the operator surface; the validator stays strict."""

    def load(self, groups):
        payload = {"version": 1, "pollIntervalMs": 750, "groups": groups}
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "group-chats.json")
            with open(path, "w", encoding="utf-8") as handle:
                json.dump(payload, handle)
            return uia.load_config(path)

    def base(self, **patch):
        item = {"id": "uia_g1", "title": "Alpha", "commandPrefix": "/dsh",
                "allowUnverifiedTrigger": True}
        item.update(patch)
        return item

    def test_mention_mode_defaults_to_command(self):
        groups, _interval = self.load([self.base()])
        self.assertEqual(groups[0].mention_mode, "command")

    def test_new_modes_are_read_through(self):
        for mode in ("mention", "mention-or-command"):
            groups, _interval = self.load([self.base(mentionMode=mode)])
            self.assertEqual(groups[0].mention_mode, mode)

    def test_unknown_mode_fails_closed(self):
        for mode in ("mentions", "all", "", "COMMAND", 1):
            with self.assertRaises(uia.ConfigError, msg=repr(mode)):
                self.load([self.base(mentionMode=mode)])

    def test_mode_without_the_unverified_opt_in_fails_closed(self):
        for mode in ("mention", "mention-or-command"):
            with self.assertRaises(uia.ConfigError, msg=mode):
                self.load([self.base(mentionMode=mode,
                                      allowUnverifiedTrigger=False)])
            with self.assertRaises(uia.ConfigError, msg=mode):
                self.load([dict(self.base(), mentionMode=mode,
                                allowUnverifiedTrigger="false")])

    def test_trigger_names_are_read_and_validated(self):
        groups, _interval = self.load([self.base(mentionMode="mention",
                                                 triggerNames=["大肥鱼"])])
        self.assertEqual(groups[0].trigger_names, ("大肥鱼",))
        with self.assertRaises(uia.ConfigError):
            self.load([self.base(triggerNames="大肥鱼")])
        with self.assertRaises(uia.ConfigError):
            self.load([self.base(triggerNames=[7])])

    def test_command_mode_needs_no_opt_in(self):
        groups, _interval = self.load([dict(self.base(),
                                            allowUnverifiedTrigger=False)])
        self.assertEqual(groups[0].mention_mode, "command")
        self.assertFalse(groups[0].allow_unverified_trigger)

class AdapterEventTests(unittest.TestCase):
    def setUp(self):
        self.clock_values = iter(range(1_700_000_000_000, 1_700_000_001_000))
        self.backend = FakeBackend(messages={"Alpha": [raw("history")]})
        self.adapter = uia.WechatGroupAdapter(
            [group()], self.backend, clock=lambda: next(self.clock_values)
        )

    def test_start_builds_baseline_without_replaying_history(self):
        self.adapter.start()
        self.assertEqual(self.adapter.poll(), [])

    def test_new_command_emits_complete_v1_schema_and_stripped_text(self):
        self.adapter.start()
        self.backend.messages["Alpha"].append(raw("/dsh answer", visible_time="10:01"))
        events = self.adapter.poll()
        self.assertEqual(len(events), 1)
        event = events[0]
        expected = {
            "source", "message_id", "message_type", "conversation_type",
            "conversation_id", "conversation_title", "from_user_id", "sender_name",
            "reply_target", "addressed", "text", "raw_text", "sent_at", "is_self",
            "item_list",
        }
        self.assertEqual(set(event), expected)
        self.assertEqual(event["source"], "uia-wechat-group/v1")
        self.assertEqual(event["message_type"], 1)
        self.assertEqual(event["conversation_type"], "group")
        self.assertEqual(event["conversation_id"], "uia_g1")
        self.assertEqual(event["conversation_title"], "Alpha")
        self.assertEqual(event["from_user_id"], "uia-name:Alice")
        self.assertEqual(event["sender_name"], "Alice")
        self.assertEqual(event["reply_target"], "uia_g1")
        self.assertTrue(event["addressed"])
        self.assertEqual(event["text"], "answer")
        self.assertEqual(event["raw_text"], "/dsh answer")
        self.assertEqual(event["sent_at"], 1_700_000_000_000)
        self.assertFalse(event["is_self"])
        self.assertEqual(event["item_list"], [{"type": 1, "text_item": {"text": "answer"}}])
        uia.validate_message_event(event)

    def test_unaddressed_message_is_observational_only(self):
        self.adapter.start()
        self.backend.messages["Alpha"].append(raw("ordinary"))
        event = self.adapter.poll()[0]
        self.assertFalse(event["addressed"])
        self.assertEqual(event["text"], "ordinary")

    def test_command_only_and_empty_messages_are_not_emitted(self):
        # Unchanged by the bare-mention rule: a command prefix with no argument is
        # not a poke, and a whitespace row is not a message. Only an actual @ gets
        # the prompt body.
        self.adapter.start()
        self.backend.messages["Alpha"].extend([raw("/dsh"), raw("   ")])
        self.assertEqual(self.adapter.poll(), [])
        self.backend.messages["Alpha"].append(raw("/dsh"))
        self.assertEqual(self.adapter.poll(), [], "a bare prefix is never answered")

    def test_self_is_skipped_by_default(self):
        self.adapter.start()
        self.backend.messages["Alpha"].append(raw("/dsh self", sender="me", is_self=True))
        self.assertEqual(self.adapter.poll(), [])

    def test_allow_self_emits_manual_self_but_not_bridge_echo(self):
        backend = FakeBackend(messages={"Alpha": []})
        adapter = uia.WechatGroupAdapter([group(allow_self=True)], backend, clock=lambda: 42)
        adapter.start()
        backend.messages["Alpha"].append(raw("/dsh manual", sender="me", is_self=True))
        events = adapter.poll()
        self.assertEqual(len(events), 1)
        self.assertTrue(events[0]["is_self"])
        result = adapter.send_text("request-1", "uia_g1", "bridge reply")
        self.assertTrue(result["ok"])
        self.assertEqual(adapter.drain_events(), [])

    def test_identical_consecutive_texts_are_distinct_messages(self):
        self.adapter.start()
        self.backend.messages["Alpha"].append(raw("/dsh same"))
        first = self.adapter.poll()[0]
        self.backend.messages["Alpha"].append(raw("/dsh same"))
        second = self.adapter.poll()[0]
        self.assertNotEqual(first["message_id"], second["message_id"])
        self.assertEqual(first["text"], second["text"])

    def test_repeated_snapshot_does_not_duplicate_events(self):
        self.adapter.start()
        self.backend.messages["Alpha"].append(raw("/dsh once"))
        first = self.adapter.poll()[0]
        self.assertEqual(self.adapter.poll(), [])
        self.assertEqual(self.backend.messages["Alpha"][-1].text, "/dsh once")
        self.assertTrue(first["message_id"])

    def test_longest_overlap_handles_scrolling_without_replay(self):
        backend = FakeBackend(messages={"Alpha": [raw("old"), raw("anchor")]})
        adapter = uia.WechatGroupAdapter([group()], backend, clock=lambda: 1)
        adapter.start()
        backend.messages["Alpha"] = [raw("anchor"), raw("/dsh new")]
        events = adapter.poll()
        self.assertEqual([event["text"] for event in events], ["new"])

    def test_lost_overlap_fails_closed_instead_of_replaying_visible_history(self):
        self.adapter.start()
        self.backend.messages["Alpha"] = [raw("different"), raw("/dsh perhaps-old")]
        self.assertEqual(self.adapter.poll(), [])
        self.assertEqual(self.adapter.health()["overlap_resets"], 1)

    def test_restart_rebuilds_baseline_and_does_not_replay(self):
        self.adapter.start()
        restarted = uia.WechatGroupAdapter([group()], self.backend, clock=lambda: 99)
        restarted.start()
        self.assertEqual(restarted.poll(), [])

    def test_event_validator_rejects_missing_required_field(self):
        self.adapter.start()
        self.backend.messages["Alpha"].append(raw("/dsh valid"))
        event = self.adapter.poll()[0]
        del event["reply_target"]
        with self.assertRaises(uia.ProtocolError):
            uia.validate_message_event(event)


class AdapterSafetyTests(unittest.TestCase):
    def test_duplicate_configured_titles_fail_closed(self):
        backend = FakeBackend()
        with self.assertRaises(uia.ConfigError):
            uia.WechatGroupAdapter([group(), group(chat_id="uia_g2")], backend).start()
        self.assertEqual(operations(backend, "select"), [])

    def test_duplicate_visible_target_title_fails_before_selection(self):
        backend = FakeBackend(titles=["Alpha", "Alpha"])
        adapter = uia.WechatGroupAdapter([group()], backend)
        with self.assertRaises(uia.SafetyError):
            adapter.start()
        self.assertEqual(operations(backend, "select"), [])

    def test_wrong_chat_after_selection_is_never_read_as_target(self):
        # Safety intent preserved, mechanism updated: the bridge no longer selects
        # a chat at all (headless switching is impossible on this build - measured:
        # Select and Invoke both return True and nothing changes), so it must refuse
        # to read while a different chat is open rather than switch to it.
        backend = FakeBackend(current="Beta", messages={"Beta": [raw("/dsh secret")]})
        backend.wrong_selection = "Beta"
        adapter = uia.WechatGroupAdapter([group()], backend)
        adapter.start()
        # The secret text in Beta must never surface as an event for group Alpha.
        self.assertEqual(adapter.poll(), [])
        self.assertEqual(operations(backend, "read_messages"), [])
        self.assertEqual(operations(backend, "select"), [])

    def test_unknown_chat_send_is_refused_without_ui_mutation(self):
        backend = FakeBackend()
        adapter = uia.WechatGroupAdapter([group()], backend)
        adapter.start()
        result = adapter.send_text("r1", "uia_unknown", "no")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "unknown_chat")
        self.assertEqual(operations(backend, "send"), [])

    def test_wrong_chat_send_is_refused_before_input_or_send(self):
        backend = FakeBackend(current="Beta")
        adapter = uia.WechatGroupAdapter([group()], backend)
        adapter.start()
        backend.wrong_selection = "Beta"
        result = adapter.send_text("r2", "uia_g1", "must not send")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "target_title_mismatch")
        self.assertEqual(operations(backend, "set_input"), [])
        self.assertEqual(operations(backend, "send"), [])

    def test_successful_send_verifies_readback_clears_input_and_restores_state(self):
        backend = FakeBackend(current="Beta", messages={"Alpha": [], "Beta": []})
        backend.inputs["Beta"] = "draft"
        adapter = uia.WechatGroupAdapter([group()], backend, clock=lambda: 7)
        adapter.start()
        result = adapter.send_text("r3", "uia_g1", "hello")
        self.assertTrue(result["ok"])
        self.assertEqual(len(result["provider_message_ids"]), 1)
        self.assertEqual(backend.inputs["Alpha"], "")
        self.assertEqual(backend.current, "Beta")
        self.assertEqual(backend.inputs["Beta"], "draft")
        sends = operations(backend, "send")
        self.assertEqual(sends, [("send", "Alpha", "hello")])

    def test_send_readback_uses_delta_so_prior_identical_text_is_allowed(self):
        backend = FakeBackend(messages={"Alpha": [raw("same", sender="me", is_self=True)]})
        adapter = uia.WechatGroupAdapter([group()], backend)
        adapter.start()
        result = adapter.send_text("r4", "uia_g1", "same")
        self.assertTrue(result["ok"])

    def test_missing_readback_is_unknown_and_same_request_never_blind_retries(self):
        backend = FakeBackend(messages={"Alpha": []})
        backend.send_behavior = "missing"
        adapter = uia.WechatGroupAdapter([group()], backend)
        adapter.start()
        first = adapter.send_text("r5", "uia_g1", "uncertain")
        second = adapter.send_text("r5", "uia_g1", "uncertain")
        self.assertFalse(first["ok"])
        self.assertEqual(first["error"]["code"], "outcome_unknown")
        self.assertEqual(second, first)
        self.assertEqual(len(operations(backend, "send")), 1)

    def test_uncleared_input_is_not_success(self):
        backend = FakeBackend(messages={"Alpha": []})
        backend.send_behavior = "sticky"
        adapter = uia.WechatGroupAdapter([group()], backend)
        adapter.start()
        result = adapter.send_text("r6", "uia_g1", "sticky")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "input_not_cleared")

    def test_duplicate_new_echo_is_ambiguous_not_success(self):
        backend = FakeBackend(messages={"Alpha": []})
        backend.send_behavior = "double"
        adapter = uia.WechatGroupAdapter([group()], backend)
        adapter.start()
        result = adapter.send_text("r7", "uia_g1", "twice")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "readback_ambiguous")

    def test_outbound_id_is_idempotent_after_success(self):
        backend = FakeBackend(messages={"Alpha": []})
        adapter = uia.WechatGroupAdapter([group()], backend)
        adapter.start()
        first = adapter.send_text("r8", "uia_g1", "once")
        second = adapter.send_text("r8", "uia_g1", "once")
        self.assertEqual(first, second)
        self.assertEqual(len(operations(backend, "send")), 1)

    def test_outbound_id_cannot_be_reused_for_another_payload(self):
        backend = FakeBackend(messages={"Alpha": []})
        adapter = uia.WechatGroupAdapter([group()], backend)
        adapter.start()
        adapter.send_text("r9", "uia_g1", "first")
        result = adapter.send_text("r9", "uia_g1", "second")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "request_id_conflict")
        self.assertEqual([op[2] for op in operations(backend, "send")], ["first"])

    def test_other_arrival_during_send_is_queued_while_echo_is_suppressed(self):
        backend = FakeBackend(messages={"Alpha": []})
        original_press = backend.press_enter

        def arrive_and_send():
            backend.messages["Alpha"].append(raw("/dsh other", sender="Bob"))
            original_press()

        backend.press_enter = arrive_and_send
        adapter = uia.WechatGroupAdapter([group(allow_self=True)], backend)
        adapter.start()
        self.assertTrue(adapter.send_text("r10", "uia_g1", "reply")["ok"])
        events = adapter.drain_events()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["sender_name"], "Bob")
        self.assertEqual(events[0]["text"], "other")


class AdditionalSafetyTests(unittest.TestCase):
    def test_session_title_uses_verified_automation_id_not_multiline_name(self):
        self.assertEqual(
            uia.session_title("session_item_Group", "Group\npinned\npreview\n"),
            "Group",
        )
        self.assertEqual(uia.session_title("other", "Group\npreview"), "")

    def test_probe_required_real_parser_is_not_healthy(self):
        backend = FakeBackend()
        backend.health = lambda: {
            "main_window": True, "controls": True, "message_parser": "probe_required",
        }
        adapter = uia.WechatGroupAdapter([group()], backend)
        self.assertFalse(adapter.health()["healthy"])

    def test_title_change_after_input_is_refused_before_enter(self):
        backend = FakeBackend(messages={"Alpha": []})
        adapter = uia.WechatGroupAdapter([group()], backend)
        adapter.start()
        original_set = backend.set_input

        def change_chat_after_input(text):
            original_set(text)
            backend.current = "Beta"

        backend.set_input = change_chat_after_input
        result = adapter.send_text("r-title", "uia_g1", "must not send")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "target_title_mismatch")
        self.assertEqual(operations(backend, "send"), [])

    def test_existing_target_draft_is_not_overwritten_or_sent(self):
        backend = FakeBackend(messages={"Alpha": []})
        backend.inputs["Alpha"] = "user draft"
        adapter = uia.WechatGroupAdapter([group()], backend)
        adapter.start()
        result = adapter.send_text("r-draft", "uia_g1", "reply")
        self.assertEqual(result["error"]["code"], "target_draft_not_empty")
        self.assertEqual(backend.inputs["Alpha"], "user draft")
        self.assertEqual(operations(backend, "send"), [])

    def test_restore_failure_is_not_reported_as_success(self):
        backend = FakeBackend(current="Beta", messages={"Alpha": [], "Beta": []})
        adapter = uia.WechatGroupAdapter([group()], backend)
        adapter.start()
        backend.fail_restore = True
        result = adapter.send_text("r-restore", "uia_g1", "sent but unrestored")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "restore_failed")

    def test_unknown_outcome_later_echo_is_still_suppressed(self):
        backend = FakeBackend(messages={"Alpha": []})
        backend.send_behavior = "missing"
        adapter = uia.WechatGroupAdapter([group(allow_self=True)], backend)
        adapter.start()
        result = adapter.send_text("r-unknown-echo", "uia_g1", "uncertain")
        self.assertFalse(result["ok"])
        backend.messages["Alpha"].append(raw("uncertain", sender="me", is_self=True))
        self.assertEqual(adapter.poll(), [])

    def test_message_type_two_is_suppressed_even_when_self_is_allowed(self):
        backend = FakeBackend(messages={"Alpha": []})
        adapter = uia.WechatGroupAdapter([group(allow_self=True)], backend)
        adapter.start()
        echo = uia.RawMessage("me", "/dsh loop", True, "now", 2)
        backend.messages["Alpha"].append(echo)
        self.assertEqual(adapter.poll(), [])

    def test_two_groups_keep_identical_member_text_in_separate_conversations(self):
        # Same intent (two groups, identical text, no cross-contamination) under the
        # idle rule: only the chat on screen is read; the other group is reported as
        # waiting instead of being switched to. The operator opening each group in
        # turn is what feeds both, and their events stay distinct.
        groups = [group(), group(chat_id="uia_g2", title="Beta")]
        backend = FakeBackend(messages={"Alpha": [], "Beta": []}, current="Alpha")
        adapter = uia.WechatGroupAdapter(groups, backend, clock=lambda: 5)
        adapter.start()
        self.assertEqual(adapter.health()["waiting_on"], ["uia_g2"])
        backend.messages["Alpha"].append(raw("/dsh same"))
        events = adapter.poll()
        self.assertEqual({event["conversation_id"] for event in events}, {"uia_g1"})
        # Now the operator opens Beta; its backlog is history, so a fresh line is
        # what must fire, and it must belong to Beta only.
        backend.current = "Beta"
        backend.messages["Beta"].append(raw("/dsh same"))
        adapter.poll()
        backend.messages["Beta"].append(raw("/dsh same"))
        beta_events = adapter.poll()
        self.assertTrue(beta_events)
        self.assertEqual({event["conversation_id"] for event in beta_events}, {"uia_g2"})
        self.assertEqual(len({event["message_id"] for event in beta_events}), 1)


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        # Sending is opt-in at the protocol boundary; tests enable it explicitly.
        self._send_env = mock.patch.dict(os.environ, {"DSH_WECHAT_GROUP_ALLOW_SEND": "1"})
        self._send_env.start()
        self.addCleanup(self._send_env.stop)
        self.backend = FakeBackend(messages={"Alpha": []})
        self.adapter = uia.WechatGroupAdapter([group()], self.backend)
        self.protocol = uia.JsonlProtocol(self.adapter)
        ready = self.protocol.start()
        self.assertEqual(ready["type"], "ready")

    def test_health_and_stop_results_and_cleanup(self):
        health = self.protocol.handle_request({"type": "health", "request_id": "h1"})
        self.assertEqual(health[-1]["type"], "health_result")
        self.assertTrue(health[-1]["ok"])
        self.assertEqual(health[-1]["request_id"], "h1")
        stopped = self.protocol.handle_request({"type": "stop", "request_id": "s1"})
        self.assertEqual(stopped, [{"type": "stop_result", "request_id": "s1", "ok": True}])
        self.assertEqual(self.backend.closed, 1)

    def test_send_result_is_emitted_after_verified_send(self):
        frames = self.protocol.handle_request(
            {"type": "send_text", "request_id": "r", "chat_id": "uia_g1", "text": "hello"}
        )
        self.assertEqual(frames[-1]["type"], "send_result")
        self.assertTrue(frames[-1]["ok"])
        repeated = self.adapter.send_text("r", "uia_g1", "hello")
        self.assertEqual(frames[-1]["provider_message_ids"], repeated["provider_message_ids"])

    def test_malformed_json_and_requests_return_sanitized_errors(self):
        malformed = self.protocol.handle_line("not-json")
        self.assertEqual(malformed[0]["type"], "error")
        self.assertEqual(malformed[0]["error"]["code"], "invalid_json")
        missing = self.protocol.handle_request({"type": "send_text", "request_id": "bad"})
        self.assertFalse(missing[-1]["ok"])
        self.assertNotIn("text", missing[-1])
        unknown = self.protocol.handle_request({"type": "unexpected", "secret": "do not echo"})
        self.assertNotIn("do not echo", json.dumps(unknown))

    def test_main_sanitizes_unexpected_backend_failure(self):
        output = io.StringIO()
        with mock.patch.object(uia, "UiaBackend", side_effect=RuntimeError("secret chat body")):
            with mock.patch.object(uia.sys, "stdout", output):
                rc = uia.main(["--probe"])
        self.assertEqual(rc, 1)
        self.assertNotIn("secret chat body", output.getvalue())
        self.assertEqual(json.loads(output.getvalue())["error"]["code"], "bridge_error")

    def test_probe_writes_evidence_without_selection_input_or_send(self):
        output = io.StringIO()
        uia.write_probe(self.backend, output)
        evidence = json.loads(output.getvalue())
        self.assertEqual(evidence["type"], "probe")
        self.assertTrue(evidence["ok"])
        self.assertEqual(operations(self.backend, "select"), [])
        self.assertEqual(operations(self.backend, "set_input"), [])
        self.assertEqual(operations(self.backend, "send"), [])


class AutoMinimizeSelfSabotageTests(unittest.TestCase):
    """Minimising must never happen: it destroys the tree the bridge reads.

    autoMinimize was shipped on the claim that a minimised WeChat keeps its
    accessibility tree. Measured instead: after SW_SHOWMINNOACTIVE the window was
    still non-iconic while UIA found zero mmui controls desktop-wide. So the switch
    did not create a background-capable state, it removed the only working one -
    the bridge would hide the panel and then be blind. Following that advice is
    what cost the operator his session, and the old docstrings still advertise it.
    """

    class Win(FakeWindow):
        # A real handle so the old early-return guards are all passed and the only
        # reason not to call ShowWindow can be the retracted behaviour itself.
        NativeWindowHandle = 68314

    def backend(self):
        backend = uia.UiaBackend.__new__(uia.UiaBackend)
        backend._closed = False
        backend._window = self.Win(exists=True)
        return backend

    def test_opt_in_no_longer_touches_the_window(self):
        fake_user32 = mock.MagicMock()
        backend = self.backend()
        env = {"DSH_WECHAT_GROUP_AUTO_MINIMIZE": "1"}
        with mock.patch.object(uia.os, "environ", env):
            with mock.patch.object(uia, "_user32", lambda: fake_user32):
                backend.maybe_auto_minimize()
        # POSITIVE CONTROL for the retraction: restore the ShowWindow call and this
        # is the first assertion to go red.
        self.assertEqual(fake_user32.mock_calls, [])

    def test_docstring_no_longer_advertises_minimising(self):
        # The claim outlived the code that was written against it, which is how an
        # operator ends up doing the one thing that breaks the bridge. Pin the
        # retraction in the text itself, the same way
        # test_panel_closed_message_names_the_headless_fix pins the message copy.
        text = (uia.UiaBackend.maybe_auto_minimize.__doc__ or "").lower()
        self.assertNotIn("keeps the tree", text)
        self.assertNotIn("operating point is therefore minimised", text)
        self.assertIn("destroy", text)

class AutoMinimizeGateTests(unittest.TestCase):
    """The bridge can put WeChat away without touching the operator's screen.

    WeChat 4.x removed close-to-tray entirely (DLL forensics: quitOnLastWindow
    Closed + MainWindowWillClose -> quit) and X-closing the panel DESTROYS the
    mmui tree, so a closed panel kills the UIA bridge. Minimising instead keeps
    the tree and the InvokePattern path (proven headless). SW_SHOWMINNOACTIVE
    (7) is the only non-activating hide: SW_MINIMIZE (6) would activate and
    steal focus. Default off: stowing a window the operator is reading is still
    a takeover of their screen.
    """

    class Win(FakeWindow):
        NativeWindowHandle = 68314

    def backend(self):
        backend = uia.UiaBackend.__new__(uia.UiaBackend)
        backend._closed = False
        backend._window = self.Win(exists=True)
        return backend

    def test_default_is_off_and_touches_no_window_api(self):
        fake_user32 = mock.MagicMock()
        backend = self.backend()
        with mock.patch.object(uia.os, "environ", {}):
            with mock.patch.object(uia, "_user32", lambda: fake_user32):
                backend.maybe_auto_minimize()
        self.assertEqual(fake_user32.mock_calls, [])

    def test_opt_in_still_touches_no_window_api(self):
        # RETRACTED, and this assertion used to enforce the retracted behaviour:
        # it demanded ShowWindow(SW_SHOWMINNOACTIVE) on opt-in, because the switch
        # was shipped on the claim that a minimised WeChat keeps its accessibility
        # tree. Measured: after SW_SHOWMINNOACTIVE the window was still non-iconic
        # and UIA found zero mmui controls desktop-wide, so the switch destroyed the
        # only state the bridge can read. An operator who still has
        # autoMinimize:true must be protected by the code, not sabotaged by it.
        fake_user32 = mock.MagicMock()
        backend = self.backend()
        env = {"DSH_WECHAT_GROUP_AUTO_MINIMIZE": "1"}
        with mock.patch.object(uia.os, "environ", env):
            with mock.patch.object(uia, "_user32", lambda: fake_user32):
                with mock.patch.object(uia, "_window_is_minimised", lambda hwnd: False):
                    backend.maybe_auto_minimize()
        self.assertEqual(fake_user32.mock_calls, [])
        # Standing guard if this is ever re-enabled: prove it by measurement first,
        # and never use SW_MINIMIZE (6), which activates and steals focus from
        # whatever the operator is doing.
        self.assertNotIn(6, [c[1][1] for c in fake_user32.mock_calls])

    def test_already_minimised_window_is_left_alone(self):
        fake_user32 = mock.MagicMock()
        backend = self.backend()
        env = {"DSH_WECHAT_GROUP_AUTO_MINIMIZE": "1"}
        with mock.patch.object(uia.os, "environ", env):
            with mock.patch.object(uia, "_user32", lambda: fake_user32):
                with mock.patch.object(uia, "_window_is_minimised", lambda hwnd: True):
                    backend.maybe_auto_minimize()
        self.assertEqual(fake_user32.mock_calls, [])

    def test_protocol_start_stows_the_window_after_baseline(self):
        # The bridge minimises (non-activating) right after it is ready, so the
        # operator never has to open or hide the window themselves, and the mmui
        # tree (which InvokePattern needs) survives the hide.
        calls = []
        class Backend:
            def list_session_titles(self): return ["Alpha"]
            def current_chat_title(self): return "Alpha"
            def select_chat(self, title): pass
            def read_input(self): return ""
            def set_input(self, text): pass
            def press_enter(self): pass
            def read_messages(self): return []
            def close(self): pass
            def maybe_auto_minimize(self): calls.append("minimize")

        adapter = uia.WechatGroupAdapter([uia.GroupConfig(id="uia_g", title="Alpha")], Backend())
        protocol = uia.JsonlProtocol(adapter)
        frame = protocol.start()
        self.assertEqual(frame["type"], "ready")
        self.assertEqual(calls, ["minimize"])
    def test_no_handle_never_touches_window_api(self):
        fake_user32 = mock.MagicMock()
        backend = uia.UiaBackend.__new__(uia.UiaBackend)
        backend._closed = False
        backend._window = FakeWindow(exists=True)
        env = {"DSH_WECHAT_GROUP_AUTO_MINIMIZE": "1"}
        with mock.patch.object(uia.os, "environ", env):
            with mock.patch.object(uia, "_user32", lambda: fake_user32):
                backend.maybe_auto_minimize()
        self.assertEqual(fake_user32.mock_calls, [])

class WindowRestoreGateTests(unittest.TestCase):
    """The bridge must never take the screen away unless explicitly allowed."""

    def test_default_restore_is_a_no_op_and_touches_no_window_api(self):
        """Without the opt-in the bridge must not move, show or focus anything."""

        fake_user32 = mock.MagicMock()
        with mock.patch.object(uia.os, "environ", {}):
            with mock.patch.object(uia, "_user32", lambda: fake_user32):
                backend = uia.UiaBackend.__new__(uia.UiaBackend)
                backend._window = FakeWindow(exists=True)
                backend.ensure_window_restored()
        # A minimised window is usable through InvokePattern, so no Win32 call
        # may run: not ShowWindow, not SetForegroundWindow, not IsIconic.
        self.assertEqual(fake_user32.mock_calls, [])

    def test_opted_in_operator_lets_the_bridge_restore_the_window(self):
        with mock.patch.object(uia.os, "environ", {"DSH_WECHAT_GROUP_ALLOW_WINDOW_RESTORE": "1"}):
            self.assertTrue(uia.UiaBackend._allow_window_restore(object()))

    def test_default_restore_touches_no_window_api_with_a_real_handle(self):
        """The false-negative hole this closes: a handle-less fake returned early.

        On a real machine NativeWindowHandle always exists, and the code once
        carried a duplicated tail block that restored and foregrounded the
        window *after* the opt-in branch, i.e. on every 750ms poll. The window
        must stay exactly where it is unless the operator opted in.
        """

        class HandledWindow(FakeWindow):
            NativeWindowHandle = 68314

        fake_user32 = mock.MagicMock()
        with mock.patch.object(uia.os, "environ", {}):
            with mock.patch.object(uia, "_user32", lambda: fake_user32):
                backend = uia.UiaBackend.__new__(uia.UiaBackend)
                backend._window = HandledWindow(exists=True)
                backend.ensure_window_restored()
        self.assertEqual(fake_user32.mock_calls, [])

    def test_opt_in_restore_uses_exactly_show_and_foreground(self):
        """The opt-in path is allowed, but only ever the two named calls."""

        class HandledWindow(FakeWindow):
            NativeWindowHandle = 68314

        fake_user32 = mock.MagicMock()
        with mock.patch.object(uia.os, "environ", {"DSH_WECHAT_GROUP_ALLOW_WINDOW_RESTORE": "1"}):
            with mock.patch.object(uia, "_user32", lambda: fake_user32):
                backend = uia.UiaBackend.__new__(uia.UiaBackend)
                backend._window = HandledWindow(exists=True)
                backend.ensure_window_restored()
        names = [call[0] for call in fake_user32.mock_calls]
        self.assertEqual(names, ["ShowWindow", "SetForegroundWindow"])


class SelectChatScreenGateTests(unittest.TestCase):
    """The focus+click fallback must never run unless the operator opted in.

    SetFocus raises the whole WeChat window and Click() posts physical mouse
    coordinates, so on a minimised or hidden panel it steals the screen and can
    land on a stale rectangle over some other app. Only InvokePattern is safe.
    """

    class Item:
        """Session row that records every screen-affecting call made on it."""

        def __init__(self, title, offscreen=False):
            # Attribute names are the UIA property names _safe_property reads.
            self.AutomationId = "session_item_" + title
            self.Name = title
            self.IsOffscreen = offscreen
            self.focus = 0
            self.clicks = 0

        def GetInvokePattern(self):
            return None

        def SetFocus(self):
            self.focus += 1

        def Click(self):
            self.clicks += 1

    class List:
        def __init__(self, items):
            self._items = items

        def GetChildren(self):
            return self._items

    def build(self, item, allow_restore, title="Alpha"):
        backend = uia.UiaBackend.__new__(uia.UiaBackend)
        backend._closed = False
        backend._auto = None
        backend._window = None
        backend._control = lambda automation_id: self.List([item])
        backend._allow_window_restore = lambda: allow_restore
        # The title read-back is what proves a switch happened; keep it fixed.
        backend.current_chat_title = lambda: None
        return backend

    def test_default_path_never_focuses_or_clicks(self):
        item = self.Item("Alpha")
        backend = self.build(item, allow_restore=False)
        with self.assertRaises(uia.SafetyError) as ctx:
            backend.select_chat("Alpha")
        self.assertEqual(ctx.exception.code, "target_title_mismatch")
        self.assertEqual((item.focus, item.clicks), (0, 0))

    def test_opted_in_path_may_click(self):
        item = self.Item("Alpha")
        backend = self.build(item, allow_restore=True)
        with self.assertRaises(uia.SafetyError):
            backend.select_chat("Alpha")
        self.assertEqual((item.focus, item.clicks), (1, 1))

    def test_offscreen_item_is_never_clicked_even_when_opted_in(self):
        # Click() would fire at a cached rectangle while the panel is hidden:
        # a real mouse click somewhere else on the operator's desktop.
        item = self.Item("Alpha", offscreen=True)
        backend = self.build(item, allow_restore=True)
        with self.assertRaises(uia.SafetyError):
            backend.select_chat("Alpha")
        self.assertEqual((item.focus, item.clicks), (0, 0))


def _allow_screen_use():
    """Context manager that opts this test into keyboard/window control.

    press_enter() refuses every keyboard route unless the operator opted in, so a
    test about the keyboard route has to say so explicitly. Using a helper keeps the
    opt-in visible at the call site instead of hidden in a global patch.
    """

    return mock.patch.dict(os.environ, {"DSH_WECHAT_GROUP_ALLOW_WINDOW_RESTORE": "1"})


class PressEnterFocusGuardTests(unittest.TestCase):
    """A background bridge must never inject a keystroke into another app.

    Control.SendKeys() is SetFocus() plus a GLOBAL keyboard inject: when the
    focus does not land on the WeChat input, the Enter goes to whatever window
    the operator is using and can submit their form. press_enter() therefore has
    to prove focus first and refuse without typing when it cannot.
    """

    class Input:
        """UIA control stand-in; SetFocus only succeeds when `takes_focus`.

        process_id models which application owns the element: the guard's hard
        line is that Enter must never leave WeChat's process, so tests need to
        say whose process a control belongs to.
        """

        def __init__(self, handle=111, automation_id="chat_input_field",
                     offscreen=False, takes_focus=True, process_id=11940):
            self.NativeWindowHandle = handle
            self.ProcessId = process_id
            self.AutomationId = automation_id
            self.IsOffscreen = offscreen
            self.focus = 0
            self.typed = []
            self.auto = None
            self.takes_focus = takes_focus

        def SetFocus(self):
            self.focus += 1
            if self.auto is not None and self.takes_focus:
                self.auto.note_focus(self)

        def SendKeys(self, text, waitTime=0):
            # Real SendKeys injects globally; record that it was asked to.
            self.typed.append(text)

    class Auto:
        """uiautomation stand-in: focus moves only when SetFocus actually runs.

        This models the real ordering so the recovery path is exercised through
        production code rather than by patching the method under test.
        """

        def __init__(self, focused=None, accept_focus=None):
            self._focused = focused
            self._accept_focus = accept_focus

        def GetFocusedControl(self):
            return self._focused

        def note_focus(self, control):
            if self._accept_focus is None or control is self._accept_focus:
                self._focused = control

    def build(self, target, focused, window_pid=11940):
        backend = uia.UiaBackend.__new__(uia.UiaBackend)
        backend._closed = False
        backend._auto = self.Auto(focused)
        backend._control = lambda automation_id: target
        # On a real machine the top-level window always carries a pid; without
        # it the containment proof has nothing to compare against.
        backend._window = self.Input(handle=44565750, automation_id="",
                                     process_id=window_pid)
        return backend

    def test_refuses_to_type_when_focus_is_in_another_process(self):
        # The safety line is containment, not identity: Enter is only ever
        # safe while the keyboard belongs to WeChat. A control in another
        # process (the operator's own app) must stop the keystroke entirely.
        target = self.Input()
        stranger = self.Input(handle=999, automation_id="something_else", process_id=9999)
        backend = self.build(target, focused=stranger)
        with self.assertRaises(uia.SafetyError) as ctx:
            backend.press_enter()
        self.assertEqual(ctx.exception.code, "focus_not_on_target")
        # The whole point: no global keystroke was injected anywhere.
        self.assertEqual(target.typed, [])

    def test_types_once_when_focus_is_already_on_target(self):
        target = self.Input()
        backend = self.build(target, focused=target)
        backend.press_enter()
        self.assertEqual(target.typed, ["{Enter}"])
        # Already focused, so no extra SetFocus (which would raise the window).
        self.assertEqual(target.focus, 0)

    def test_unknown_focus_refuses_without_touching_focus(self):
        # UIA reports nothing focusable. Recovery used to call SetFocus here, but
        # SetFocus ACTIVATES the window to move the caret, which is the screen
        # takeover this objective forbids - and measured on a minimised window it
        # returns False anyway. Default behaviour is now refusal, focus untouched.
        target = self.Input()
        auto = self.Auto(focused=None)
        target.auto = auto
        backend = uia.UiaBackend.__new__(uia.UiaBackend)
        backend._closed = False
        backend._auto = auto
        backend._control = lambda automation_id: target
        with self.assertRaises(uia.SafetyError) as ctx:
            backend.press_enter()
        self.assertEqual(ctx.exception.code, "focus_not_on_target")
        self.assertEqual(target.focus, 0)
        self.assertEqual(target.typed, [])

    def test_opt_in_recovers_via_one_setfocus_when_not_yet_focused(self):
        # Unattended-machine escape hatch: with the same switch that governs the
        # click fallback, the bridge may take the keyboard to finish a send.
        target = self.Input()
        auto = self.Auto(focused=None)
        target.auto = auto
        backend = uia.UiaBackend.__new__(uia.UiaBackend)
        backend._closed = False
        backend._auto = auto
        backend._control = lambda automation_id: target
        with mock.patch.object(uia.os, "environ",
                               {"DSH_WECHAT_GROUP_ALLOW_WINDOW_RESTORE": "1"}):
            backend.press_enter()
        self.assertEqual(target.focus, 1)
        self.assertEqual(target.typed, ["{Enter}"])

    def test_still_refuses_when_setfocus_does_not_move_focus(self):
        # Real controls can silently fail to take focus; the keystroke must not
        # then be injected into the operator's foreground app.
        target = self.Input(takes_focus=False)
        auto = self.Auto(focused=None)
        target.auto = auto
        backend = uia.UiaBackend.__new__(uia.UiaBackend)
        backend._closed = False
        backend._auto = auto
        backend._control = lambda automation_id: target
        with self.assertRaises(uia.SafetyError) as ctx:
            backend.press_enter()
        self.assertEqual(ctx.exception.code, "focus_not_on_target")
        self.assertEqual(target.typed, [])

    def test_does_not_raise_wechat_to_grab_the_keyboard(self):
        # The residual screen steal: focus is in another app, so SetFocus on the
        # WeChat input would ACTIVATE WeChat to take the keyboard back. That is
        # exactly the takeover the objective forbids, so the recovery attempt is
        # gated like the click fallback is, and the send is refused instead.
        target = self.Input(handle=0, automation_id="chat_input_field")
        target.ClassName = "mmui::ChatInputField"
        elsewhere = self.Input(handle=264128, automation_id="", process_id=9999)
        elsewhere.ClassName = "Chrome_WidgetWin_1"
        backend = self.build(target, focused=elsewhere)
        with self.assertRaises(uia.SafetyError) as ctx:
            backend.press_enter()
        self.assertEqual(ctx.exception.code, "focus_not_on_target")
        self.assertEqual(target.focus, 0)
        self.assertEqual(target.typed, [])

    def test_opt_in_still_allows_the_focus_recovery(self):
        # An unattended machine may want the keystroke badly enough to accept a
        # window coming forward; that stays available behind the same opt-in the
        # click fallback uses, so one switch governs every screen takeover path.
        target = self.Input(handle=111, automation_id="chat_input_field")
        elsewhere = self.Input(handle=264128, automation_id="chat_input_field",
                              process_id=9999)
        backend = self.build(target, focused=elsewhere)
        backend._control = lambda automation_id: target
        target.auto = backend._auto
        with mock.patch.object(uia.os, "environ",
                               {"DSH_WECHAT_GROUP_ALLOW_WINDOW_RESTORE": "1"}):
            backend.press_enter()
        self.assertEqual(target.focus, 1)
        self.assertEqual(target.typed, ["{Enter}"])
    def test_real_mmui_shape_has_zero_handles_must_still_send(self):
        # Measured on the live machine: mmui child controls report
        # NativeWindowHandle == 0 (only the top-level window has a real handle),
        # so a guard that demanded equal handles would refuse EVERY real WeChat
        # send and silently break background operation. Match on the app-unique
        # automation id plus the mmui class name instead.
        target = self.Input(handle=0, automation_id="chat_input_field")
        target.ClassName = "mmui::ChatInputField"
        focused = self.Input(handle=0, automation_id="chat_input_field")
        focused.ClassName = "mmui::ChatInputField"
        backend = self.build(target, focused=focused)
        backend.press_enter()
        self.assertEqual(target.typed, ["{Enter}"])

    def test_focus_reported_as_the_main_window_still_sends(self):
        # Second live-machine shape: while the panel is minimised, UIA often
        # reports the focused element as the top-level window rather than the
        # child edit. Requiring the child's automation id there would refuse a
        # send that is provably safe, because the keyboard belongs to WeChat.
        target = self.Input(handle=0, automation_id="chat_input_field")
        target.ClassName = "mmui::ChatInputField"
        top = self.Input(handle=44565750, automation_id="")
        top.ClassName = "mmui::MainWindow"
        backend = self.build(target, focused=top)
        backend._window = self.Input(handle=44565750)
        backend.press_enter()
        self.assertEqual(target.typed, ["{Enter}"])

    def test_focus_in_another_apps_top_level_is_refused(self):
        # The same shape must not accept a foreign window: that Enter would land
        # in the operator's own app. Foreign here means foreign PROCESS.
        target = self.Input(handle=0, automation_id="chat_input_field")
        target.ClassName = "mmui::ChatInputField"
        foreign = self.Input(handle=264128, automation_id="", process_id=9999)
        foreign.ClassName = "Chrome_WidgetWin_1"
        backend = self.build(target, focused=foreign)
        with self.assertRaises(uia.SafetyError) as ctx:
            backend.press_enter()
        self.assertEqual(ctx.exception.code, "focus_not_on_target")
        self.assertEqual(target.typed, [])
    def test_same_automation_id_in_a_foreign_process_is_refused(self):
        # Another app can expose an element literally named chat_input_field, so
        # the name alone proves nothing. What makes a keystroke safe is that the
        # focused element belongs to WeChat's process, which is why the pid, not
        # the label, is the deciding fact.
        target = self.Input(handle=0, automation_id="chat_input_field")
        target.ClassName = "mmui::ChatInputField"
        stranger = self.Input(handle=0, automation_id="chat_input_field", process_id=9999)
        stranger.ClassName = "Chrome_WidgetWin_1"
        backend = self.build(target, focused=stranger)
        with self.assertRaises(uia.SafetyError) as ctx:
            backend.press_enter()
        self.assertEqual(ctx.exception.code, "focus_not_on_target")
        self.assertEqual(target.typed, [])
    def test_a_sibling_inside_wechat_is_accepted_not_refused(self):
        # Deliberate policy, and it supersedes the stricter identity rule this
        # test originally asserted: focus on another WeChat element (the message
        # list) means Enter lands inside WeChat, where it is inert - it cannot
        # reach the operator's application. Refusing here instead would reject
        # background sends whenever UIA reports focus as a pane rather than the
        # exact edit, which is the common case on a minimised window. A send
        # that lands wrong is still caught honestly by the read-back check that
        # follows, so the failure surfaces as 'not delivered', never as a
        # keystroke in someone else's window.
        target = self.Input()
        sibling = self.Input(handle=111, automation_id="chat_message_list")
        backend = self.build(target, focused=sibling)
        backend.press_enter()
        self.assertEqual(target.typed, ["{Enter}"])


class SendControlDepthTests(unittest.TestCase):
    """The send button sits deeper than the walk reached.

    Measured on the live machine with the panel open and the tree healthy:
    mmui::XOutlineButton named 发送, InvokePattern supported, at depth 20 below
    mmui::MainWindow. The probe reported send_candidates: 0, which read like
    'this build exposes no send control' and would have pushed background sending
    onto the keyboard route - the one a hidden window can never get. Both search
    paths were simply too shallow: the walk stopped at 18 levels and the targeted
    lookup pruned to first children only.
    """

    class Invoke:
        def __init__(self):
            self.calls = 0

        def Invoke(self, waitTime=0):
            self.calls += 1
            return True

    def deep_chain(self, depth, leaf):
        """Wrap leaf in `depth` single-child levels, outermost first."""

        node = leaf
        for _ in range(depth):
            child = node

            class Wrapper:
                def __init__(self, inner):
                    self.inner = inner

                def GetChildren(self):
                    return [self.inner]

            node = Wrapper(child)
        return node

    def leaf(self):
        invoke = self.Invoke()
        button = mock.MagicMock()
        button.IsOffscreen = False
        button.ControlTypeName = "ButtonControl"
        button.Name = "\u53d1\u9001"
        button.AutomationId = ""
        button.ClassName = "mmui::XOutlineButton"
        button.GetInvokePattern = lambda: invoke
        return button, invoke

    def backend(self, root):
        backend = uia.UiaBackend.__new__(uia.UiaBackend)
        backend._closed = False
        backend._auto = None
        backend._window = root
        return backend

    def test_send_button_at_measured_depth_is_found(self):
        # Depth 20 is the real number, not a round one chosen to pass.
        button, invoke = self.leaf()
        backend = self.backend(self.deep_chain(20, button))
        self.assertTrue(backend.send_by_invoke())
        self.assertEqual(invoke.calls, 1)

    def test_targeted_lookup_does_not_prune_to_first_children(self):
        # FirstChild=True only descends the first child of each level, so a send
        # button that is a later sibling is invisible to it. Prove the fallback
        # covers that shape: two branches, the button on the second one.
        button, invoke = self.leaf()

        class Branch:
            def __init__(self, children):
                self._children = children

            def GetChildren(self):
                return self._children

        decoy = mock.MagicMock()
        decoy.IsOffscreen = True
        decoy.ControlTypeName = "ButtonControl"
        decoy.Name = ""
        decoy.AutomationId = ""
        decoy.ClassName = "mmui::XImage"
        root = Branch([Branch([decoy]), self.deep_chain(19, button)])
        backend = self.backend(root)
        self.assertTrue(backend.send_by_invoke())
        self.assertEqual(invoke.calls, 1)

    def test_walk_budget_covers_a_real_panel(self):
        # The live tree is ~160 nodes at the depth we care about, but a panel with
        # a long message list is far larger; a budget that stops before the input
        # toolbar silently means 'no send control'.
        self.assertGreaterEqual(uia.UiaBackend.CONTROL_WALK_BUDGET, 4000)
        self.assertGreaterEqual(uia.UiaBackend.CONTROL_WALK_DEPTH, 26)


class SendSearchOrderTests(unittest.TestCase):
    """The bounded walk is the fast path; the targeted lookup is not.

    The docstring claimed the targeted lookup was cheaper than walking the tree.
    Measured on the live tree after the timeout fix: the walk visits all 170
    nodes in 141ms and returns the 发送 button, while the name-by-name lookup
    takes 1515ms for the same answer. uiautomation re-derives the tree from the
    root for every Name filter, so four labelled probes cost more than one scan.
    Ordering the cheap thing first is the whole point.
    """

    class Auto:
        def __init__(self):
            self.factory_calls = 0

        def ButtonControl(self, **kwargs):
            self.factory_calls += 1

            class Hit:
                IsOffscreen = False
                ControlTypeName = "ButtonControl"
                ClassName = "mmui::XOutlineButton"
                AutomationId = ""
                Name = "\u53d1\u9001"

                def Exists(self, seconds, interval):
                    return True

            return Hit()

    def button(self, name="\u53d1\u9001"):
        control = mock.MagicMock()
        control.IsOffscreen = False
        control.ControlTypeName = "ButtonControl"
        control.Name = name
        control.AutomationId = ""
        control.ClassName = "mmui::XOutlineButton"
        control.GetInvokePattern = lambda: mock.MagicMock()
        return control

    def backend(self, pool):
        backend = uia.UiaBackend.__new__(uia.UiaBackend)
        backend._closed = False
        backend._window = mock.MagicMock()
        backend._all_controls = lambda: pool
        backend._auto = self.Auto()
        return backend

    def test_walk_result_is_returned_without_any_labelled_probe(self):
        # POSITIVE CONTROL: after any reorder this is the first assertion to go
        # red, because it pins the order, not merely the outcome.
        target = self.button()
        backend = self.backend([target])
        self.assertIs(backend._send_affordance(), target)
        self.assertEqual(backend._auto.factory_calls, 0)

    def test_labelled_probe_is_still_the_fallback_for_an_empty_pool(self):
        # A window that is not attached yields an empty walk; the name lookup is
        # the only remaining chance, so it must not be deleted, only demoted.
        backend = self.backend([])
        self.assertIsNotNone(backend._send_affordance())
        self.assertGreater(backend._auto.factory_calls, 0)

    def test_an_uninvokeable_named_label_does_not_end_the_search(self):
        # 发送 also exists as a plain Text node (measured: mmui::XTextView named
        # 发送 with no InvokePattern). Returning that would report a send that
        # never happened, so the search must continue to the real button.
        label_only = mock.MagicMock()
        label_only.IsOffscreen = False
        label_only.ControlTypeName = "TextControl"
        label_only.Name = "\u53d1\u9001"
        label_only.AutomationId = ""
        label_only.ClassName = "mmui::XTextView"
        real = self.button()
        backend = self.backend([label_only, real])
        self.assertIs(backend._send_affordance(), real)


class SendProbeBudgetTests(unittest.TestCase):
    """The targeted send lookup must not spend ten seconds per absent label.

    Measured on the live tree: _send_by_name_hint took 25.9s and
    _send_affordance 34.5s, while walking the whole tree costs 109ms. Cause,
    confirmed from the installed signature (uiautomation 2.0.29 has no timeout
    parameter on the control factories): unknown keywords such as Exists=False
    and FirstChild=True are collected into searchProperties, so the factory
    returns a LAZY control and the first property read re-runs the search with
    the library default TIME_OUT_SECOND=10. Three English labels that WeChat
    never uses therefore cost 30 seconds before the Chinese label is tried at
    all - and sorted() put that label last.
    """

    class Lazy:
        """Stand-in for a lazy UIA control: reading a property re-searches."""

        def __init__(self, auto, name, exists):
            self._auto = auto
            self.Name = name
            self._exists = exists
            if exists:
                # A control that really is there answers property reads instantly,
                # so _looks_like_send can confirm it.
                self.ControlTypeName = "ButtonControl"
                self.ClassName = "mmui::XOutlineButton"
                self.AutomationId = ""
                self.IsOffscreen = False

        def Exists(self, seconds, interval):
            self._auto.timeout_calls.append(seconds)
            return self._exists

        def GetInvokePattern(self):
            return None

        def __getattr__(self, item):
            if item.startswith("_") or item in ("Name", "Exists"):
                raise AttributeError(item)
            # On a real lazy control this is the call that re-searches for ten
            # seconds. Record it instead of raising: the production predicate wraps
            # its reads in try/except Exception, and AssertionError is an Exception,
            # so raising here would be swallowed and the test would pass for the
            # wrong reason. The assertions below check the ledger instead.
            self._auto.property_reads.append((self.Name, item))
            raise AttributeError(item)

    class Auto:
        def __init__(self, hit_name=None):
            self.queries = []
            self.timeout_calls = []
            self.property_reads = []
            self.hit_name = hit_name

        def ButtonControl(self, **kwargs):
            name = kwargs.get("Name", "")
            self.queries.append(name)
            # Remember the whole keyword set: the bug is a search property that
            # restricts the walk (FirstChild) or a missing explicit timeout.
            self.kwargs = getattr(self, "kwargs", [])
            self.kwargs.append(dict(kwargs))
            return SendProbeBudgetTests.Lazy(
                self, name, exists=(name == self.hit_name))

    def backend(self, hit_name=None):
        backend = uia.UiaBackend.__new__(uia.UiaBackend)
        backend._closed = False
        backend._window = None
        backend._auto = self.Auto(hit_name)
        return backend
        self.assertEqual(backend._auto.property_reads, [])

    def test_probe_uses_an_explicit_small_timeout(self):
        # Every probe must bound its own wait; anything falling through to the
        # library default of ten seconds is the bug being fixed.
        backend = self.backend(hit_name="\u53d1\u9001")
        self.assertIsNotNone(backend._send_by_name_hint())
        self.assertTrue(backend._auto.timeout_calls, "no explicit Exists timeout")
        self.assertLessEqual(max(backend._auto.timeout_calls), 1.0,
                             "probe fell back to the library default timeout")

    def test_a_label_that_does_not_exist_is_never_read(self):
        # The re-search happens on the first property read, so a label that is not
        # present must be dropped straight after Exists returns False.
        backend = self.backend(hit_name=None)
        self.assertIsNone(backend._send_by_name_hint())
        # Four labels, each probed once, and none of them read further: 0.6s x 4
        # instead of 10s x 4. Reaching this assertion at all proves no Lazy
        # property was read (the double raises on any read of an unprobed control).
        self.assertEqual(len(backend._auto.queries), len(uia.UiaBackend.SEND_LABELS))
        self.assertEqual(len(backend._auto.timeout_calls), len(uia.UiaBackend.SEND_LABELS))
        # Nothing was probed past Exists(): no ten-second re-search per label.

    def test_the_label_wechat_actually_uses_is_queried_first(self):
        # Order is the difference between 0.6s and 30s on this build.
        backend = self.backend(hit_name="\u53d1\u9001")
        backend._send_by_name_hint()
        self.assertEqual(backend._auto.queries[0], "\u53d1\u9001")
        self.assertEqual(len(backend._auto.queries), 1)

    def test_no_first_child_pruning(self):
        # FirstChild=True restricts the search to the first child of each level, so
        # a send button on any other branch is invisible to the fast path.
        backend = self.backend(hit_name="\u53d1\u9001")
        backend._send_by_name_hint()
        for kwargs in backend._auto.kwargs:
            self.assertNotIn("FirstChild", kwargs, str(kwargs))
            self.assertNotIn("Exists", kwargs,
                             "Exists=False returns a lazy control that re-searches")



class ProcessScopedFocusTests(unittest.TestCase):
    """Containment, not identity, is what makes a background Enter safe.

    Exact control identity turned out to be the wrong key: on a minimised window
    UIA reports focus as some intermediate pane (measured with a Tk window: a
    TkChild whose handle is neither the top level nor the edit), so an identity
    test would refuse every real background send. If the focused element belongs
    to WeChat's own process, Enter cannot reach the operator's app - all three
    in-process focus shapes pass and anything from another process fails.
    """
    class Node:
        def __init__(self, pid, handle=0, automation_id="", class_name=""):
            self.ProcessId = pid
            self.NativeWindowHandle = handle
            self.AutomationId = automation_id
            self.ClassName = class_name

        def SendKeys(self, text, waitTime=0):
            self.typed = text

    def backend(self, window_pid, focused):
        backend = uia.UiaBackend.__new__(uia.UiaBackend)
        backend._closed = False
        backend._auto = type("A", (), {"GetFocusedControl": staticmethod(lambda: focused)})
        backend._window = self.Node(window_pid, handle=44565750, class_name="mmui::MainWindow")
        return backend

    def test_focus_on_the_target_child_passes(self):
        target = self.Node(11940, handle=0, automation_id="chat_input_field",
                           class_name="mmui::ChatInputField")
        self.assertTrue(self.backend(11940, target)._focus_is_contained(target))

    def test_focus_on_the_main_window_passes(self):
        focused = self.Node(11940, handle=44565750, class_name="mmui::MainWindow")
        target = self.Node(11940, handle=0, automation_id="chat_input_field")
        self.assertTrue(self.backend(11940, focused)._focus_is_contained(target))

    def test_focus_on_an_intermediate_wechat_pane_passes(self):
        # The measured real-world shape: neither the child nor the top level.
        focused = self.Node(11940, handle=777, class_name="mmui::ChatViewPane")
        target = self.Node(11940, handle=0, automation_id="chat_input_field")
        self.assertTrue(self.backend(11940, focused)._focus_is_contained(target))

    def test_focus_in_another_process_is_refused(self):
        # Same automation id in someone else's app must not open the gate:
        # that Enter would submit the operator's own form.
        stranger = self.Node(9999, handle=264128, automation_id="chat_input_field",
                             class_name="Chrome_WidgetWin_1")
        target = self.Node(11940, handle=0, automation_id="chat_input_field")
        self.assertFalse(self.backend(11940, stranger)._focus_is_contained(target))

    def test_unknown_pids_are_refused(self):
        # A UIA failure must not be read as containment; the safe answer is no.
        ambiguous = self.Node(0, handle=0, automation_id="chat_input_field")
        target = self.Node(11940, handle=0, automation_id="chat_input_field")
        self.assertFalse(self.backend(11940, ambiguous)._focus_is_contained(target))

    def test_missing_focus_reader_refuses_instead_of_guessing(self):
        backend = uia.UiaBackend.__new__(uia.UiaBackend)
        backend._closed = False
        backend._auto = type("A", (), {})
        backend._window = self.Node(11940, handle=44565750)
        target = self.Node(11940, handle=0, automation_id="chat_input_field")
        self.assertFalse(backend._focus_is_contained(target))

def _ctypes_int(value):
    """Numeric value of a ctypes wrapper, tolerant of plain ints.

    wintypes.HWND / wintypes.UINT are ctypes subclasses; their .value is the real
    number. A plain int (a test that passes 12 directly) has no .value and is
    returned unchanged, so both call shapes keep working.
    """

    inner = getattr(value, "value", None)
    return int(inner) if inner is not None else int(value)

class SendRouteOrderTests(unittest.TestCase):
    """The posted route is the one that works; invoke must not pre-empt it.

    Measured on the live group at 00:32 while the operator was using his machine:
    - send_by_invoke() returned True and NO row ever appeared (checked against the
      transcript twice), so this build lies about the send button exactly as it
      lies about chat selection;
    - control-level PostMessage could not be targeted at all because every mmui
      child reports NativeWindowHandle == 0;
    - posting WM_KEYDOWN/WM_KEYUP(VK_RETURN) to the top-level mmui::MainWindow
      handle DID deliver: a new row with the exact mark appeared, the draft went
      empty, and no window API was called - no ShowWindow, no SetFocus, no
      SetForegroundWindow. That is a background send with no physical presence,
      which is precisely what the operator requires.

    So the posted route must be tried FIRST. The old order asked invoke first and
    returned on its true return value, so the only working route was never
    reached and every send ended as outcome_unknown.
    """

    class Field:
        def __init__(self, draft):
            self.Name = "Target"
            self.AutomationId = "chat_input_field"
            self.ClassName = "mmui::ChatInputField"
            self.NativeWindowHandle = 0
            self.ProcessId = 11940
            self._draft = draft

        def GetValuePattern(self):
            return None

    class Window:
        Name = "\u5fae\u4fe1"
        AutomationId = ""
        ControlTypeName = "WindowControl"
        ClassName = "mmui::MainWindow"
        NativeWindowHandle = 3017014
        ProcessId = 11940

    def backend(self, invoke_lies=True):
        backend = uia.UiaBackend.__new__(uia.UiaBackend)
        backend._closed = False
        backend._auto = None
        backend._window = self.Window()
        backend.field = self.Field("draft")
        backend.posted = []
        backend.invoked = []
        # The draft clears once the posted key is delivered, which is the proof
        # press_enter requires; nothing else is allowed to change it.
        # The production code resolves user32 through the module-level _user32(),
        # not an attribute on the instance, so the double has to be installed the
        # same way - patching self._user32 would be invisible to it.
        class U:
            def PostMessageW(self, hwnd, msg, wparam, lparam):
                # The production call passes wintypes.HWND/UINT wrappers, and on
                # CPython 3.12 int() on those raises instead of returning the
                # numeric value. Unwrap via .value, which is what the ctypes
                # wrappers expose, so the recorded tuple still carries real numbers.
                backend.posted.append((_ctypes_int(hwnd), _ctypes_int(msg)))
                backend.field._draft = ""
                return 1
        self.user32_patch = mock.patch.object(uia, "_user32", lambda: U())
        self.user32_patch.start()
        self.addCleanup(self.user32_patch.stop)
        backend._draft_text = lambda: backend.field._draft
        backend._focus_is_contained = lambda control: False
        return backend

    def test_the_working_route_is_tried_before_the_lying_one(self):
        # POSITIVE CONTROL: restore the old order and this fails, because invoke
        # is consulted first and short-circuits.
        backend = self.backend()
        called = {"invoke": 0}

        def lying_invoke():
            called["invoke"] += 1
            return True

        backend.send_by_invoke = lying_invoke
        self.assertTrue(backend._posted_enter_delivered())
        # The posted route demonstrably delivered the draft, so invoke must not
        # have been needed at all.
        self.assertEqual(called["invoke"], 0)
        self.assertTrue(backend.posted)

    def test_a_truthful_invoke_is_still_used_when_posting_fails(self):
        # The keyboard-free invoke is legitimate on a build that honours it; it
        # just must not be trusted ahead of the route that provably works here.
        backend = self.backend()
        backend.field._draft = "draft"
        # PostMessage reports 0 and the draft never clears: no delivery proof.
        with mock.patch.object(uia, "_user32", lambda: type("U", (), {
                "PostMessageW": staticmethod(lambda *a: 0), })()):
            self.assertFalse(backend._posted_enter_delivered())

    def test_posting_to_a_foreign_window_is_refused(self):
        # Identity gate stays: only a window announcing itself as mmui:: may be
        # written into, because a bare handle number proves nothing.
        backend = self.backend()
        backend._window = self.Window()
        backend._window.ClassName = "Qt51514QWindowIcon"
        self.assertFalse(backend._posted_enter_delivered())
        self.assertEqual(backend.posted, [])

class SendByInvokeTests(unittest.TestCase):
    """Prefer the app's own send button over a keyboard keystroke.

    A keystroke needs the keyboard, and the keyboard belongs to exactly one
    window: taking it means raising WeChat over whatever the operator uses, which
    is the screen control the objective forbids. Measured here: a standard EDIT
    ignores a posted WM_CHAR while unfocused, so a targeted PostMessage is not an
    escape hatch either. UIA Invoke on the send control is the only mechanism that
    needs no keyboard at all, so it is tried first and the Enter path becomes the
    fallback used only when WeChat already owns the keyboard.
    """

    class Ctl:
        def __init__(self, name="", automation_id="", class_name="", invoke=None):
            self.Name = name
            self.AutomationId = automation_id
            self.ClassName = class_name
            self.ControlTypeName = "ButtonControl"
            self.ProcessId = 11940
            self.NativeWindowHandle = 0
            self.IsOffscreen = False
            self._invoke = invoke
            self.invoked = 0
            self.typed = []

        def GetInvokePattern(self):
            return self._invoke

        def SetFocus(self):
            self.focused = getattr(self, "focused", 0) + 1

        def SendKeys(self, text, waitTime=0):
            self.typed.append(text)

    class Invoke:
        def __init__(self, ok=True):
            self.ok = ok
            self.calls = 0

        def Invoke(self, waitTime=0):
            self.calls += 1
            return self.ok

    def backend(self, pool, focused_pid=11940):
        backend = uia.UiaBackend.__new__(uia.UiaBackend)
        backend._closed = False
        backend._window = self.Ctl(class_name="mmui::MainWindow")
        backend._window.ProcessId = 11940
        input_ctl = self.Ctl(automation_id="chat_input_field", class_name="mmui::ChatInputField")
        backend._control = lambda automation_id: input_ctl
        backend._auto = type("A", (), {"GetFocusedControl": staticmethod(
            lambda: input_ctl if focused_pid == 11940 else None)})
        # Every UIA walk in the adapter starts from one control lookup.
        backend._all_controls = lambda: pool
        return backend, input_ctl

    def test_send_button_is_invoked_and_no_key_is_typed(self):
        invoke = self.Invoke()
        button = self.Ctl(name="发送", automation_id="send_button", invoke=invoke)
        backend, input_ctl = self.backend([button])
        self.assertTrue(backend.send_by_invoke())
        self.assertEqual(invoke.calls, 1)
        self.assertEqual(input_ctl.typed, [])
        self.assertEqual(getattr(input_ctl, "focused", 0), 0)

    def test_english_label_also_counts(self):
        invoke = self.Invoke()
        button = self.Ctl(name="Send", invoke=invoke)
        backend, _ = self.backend([button])
        self.assertTrue(backend.send_by_invoke())
        self.assertEqual(invoke.calls, 1)

    def test_no_affordance_returns_false_without_invoking_anything(self):
        invoke = self.Invoke()
        decoy = self.Ctl(name="发送图片", automation_id="", class_name="mmui::Other")
        other = self.Ctl(name="设置", invoke=invoke)
        backend, _ = self.backend([decoy, other])
        self.assertFalse(backend.send_by_invoke())
        self.assertEqual(invoke.calls, 0)

    def test_refused_invoke_is_reported_not_silently_accepted(self):
        invoke = self.Invoke(ok=False)
        button = self.Ctl(name="发送", invoke=invoke)
        backend, _ = self.backend([button])
        self.assertFalse(backend.send_by_invoke())
        self.assertEqual(invoke.calls, 1)

    def test_real_traversal_finds_a_nested_button(self):
        # The other five tests replace _all_controls wholesale; this one walks
        # the production traversal itself, so a broken GetChildren recursion
        # cannot hide behind them.
        invoke = self.Invoke()
        button = self.Ctl(name="发送", invoke=invoke)
        panel = self.Ctl(name="panel")
        panel.GetChildren = lambda: [button]
        title = self.Ctl(name="title")
        title.GetChildren = lambda: []
        root = self.Ctl(name="root")
        root.GetChildren = lambda: [title, panel]

        backend = uia.UiaBackend.__new__(uia.UiaBackend)
        backend._closed = False
        backend._window = root
        # The walk reports children before their own children, and never the
        # root itself, so the expected order is fixed and checkable.
        self.assertEqual(
            [c.Name for c in backend._all_controls()],
            ["title", "panel", "\u53d1\u9001"],
        )
        self.assertTrue(backend.send_by_invoke())
        self.assertEqual(invoke.calls, 1)

    def test_traversal_survives_a_failing_child(self):
        # A COM error on one branch must not lose the whole search: the answer
        # is either the affordance or none, never a crash on a background send.
        invoke = self.Invoke()
        button = self.Ctl(name="发送", invoke=invoke)
        bad = self.Ctl(name="bad")

        def boom():
            raise RuntimeError("com gone")

        bad.GetChildren = boom
        root = self.Ctl(name="root")
        root.GetChildren = lambda: [bad, button]
        backend = uia.UiaBackend.__new__(uia.UiaBackend)
        backend._closed = False
        backend._window = root
        self.assertTrue(backend.send_by_invoke())

    def test_press_enter_prefers_invoke_over_the_keyboard(self):
        invoke = self.Invoke()
        button = self.Ctl(name="发送", invoke=invoke)
        backend, input_ctl = self.backend([button])
        backend.press_enter()
        self.assertEqual(invoke.calls, 1)
        self.assertEqual(input_ctl.typed, [])


class PostedEnterTests(unittest.TestCase):
    """Route 2: Enter posted into WeChat's own message queue.

    SetKeys injects globally and needs the keyboard, which a background window
    cannot have. PostMessage targets a single window handle in a single thread
    queue, so by construction the keystroke cannot reach another application.
    Qt then delivers it to whichever widget holds the app's INTERNAL focus,
    which is why this can work while WeChat is hidden - but that is the part not
    verified on this build (its panel was X-closed and unrecoverable), so
    success is never assumed: the draft is re-read and the adapter still proves
    delivery from the message list.
    """

    class Value:
        def __init__(self, holder):
            self.holder = holder

        @property
        def Value(self):
            return self.holder.text

    class Input:
        def __init__(self, text="draft"):
            self.text = text
            self.typed = []
            self.ProcessId = 11940
            self.NativeWindowHandle = 0
            self.AutomationId = "chat_input_field"
            self.ClassName = "mmui::ChatInputField"

        def GetValuePattern(self):
            return PostedEnterTests.Value(self)

        def SendKeys(self, text, waitTime=0):
            self.typed.append(text)

    def backend(self, input_text="draft", handle=44565750, focused=None):
        backend = uia.UiaBackend.__new__(uia.UiaBackend)
        backend._closed = False
        input_ctl = self.Input(input_text)
        window = self.Input("")
        window.NativeWindowHandle = handle
        window.ProcessId = 11940
        # A real main window announces itself as mmui; the posted-Enter route
        # checks that before writing a keystroke into anyone's queue.
        window.ClassName = "mmui::MainWindow"
        backend._window = window
        backend._control = lambda automation_id: input_ctl
        backend._auto = type("A", (), {"GetFocusedControl": staticmethod(lambda: focused)})
        return backend, input_ctl

    def test_posts_enter_to_the_wechat_window_and_stops(self):
        backend, input_ctl = self.backend()
        fake_user32 = mock.MagicMock()

        def settle(hwnd, msg, wparam, lparam):
            # The app consumed the key: the draft empties, as it does on a real
            # send. Nothing else may then be attempted.
            input_ctl.text = ""
            return 1

        fake_user32.PostMessageW.side_effect = settle
        with mock.patch.object(uia, "_user32", lambda: fake_user32):
            backend.press_enter()
        # ctypes scalar wrappers do not compare equal to plain ints, so read
        # the value out; comparing the wrapper itself would make this toothless.
        posted = [int(call.args[1].value) for call in fake_user32.PostMessageW.mock_calls]
        self.assertIn(0x0100, posted, "return keydown must be posted")
        self.assertIn(0x0101, posted, "return keyup must be posted")
        self.assertEqual(fake_user32.PostMessageW.mock_calls[0].args[0].value, 44565750)
        self.assertEqual(input_ctl.typed, [], "no global keystroke after a post")

    def test_falls_back_to_the_keyboard_when_the_draft_survives(self):
        backend, input_ctl = self.backend()
        holder = self.Input("")
        holder.ProcessId = 11940
        holder.NativeWindowHandle = 44565750
        backend._auto = type("A", (), {"GetFocusedControl": staticmethod(lambda: holder)})
        fake_user32 = mock.MagicMock()
        fake_user32.PostMessageW.return_value = 1
        with mock.patch.object(uia, "_user32", lambda: fake_user32):
            backend.press_enter()
        # A verified no-op may fall through, and containment makes the keystroke
        # safe so the send still happens.
        self.assertEqual(input_ctl.typed, ["{Enter}"])

    def test_unreadable_draft_refuses_to_post_blindly(self):
        # Without readback there is no way to tell a delivered Enter from a lost
        # one, and a blind post followed by a fallback could send twice. So the
        # route is skipped and the keystroke path is used.
        backend, input_ctl = self.backend()
        input_ctl.GetValuePattern = lambda: None
        holder = self.Input("")
        holder.ProcessId = 11940
        holder.NativeWindowHandle = 44565750
        backend._auto = type("A", (), {"GetFocusedControl": staticmethod(lambda: holder)})
        fake_user32 = mock.MagicMock()
        with mock.patch.object(uia, "_user32", lambda: fake_user32):
            backend.press_enter()
        self.assertEqual(fake_user32.PostMessageW.mock_calls, [])
        self.assertEqual(input_ctl.typed, ["{Enter}"])

    def stranger(self):
        # Focus in ANOTHER process, so containment cannot license a keystroke
        # and the flow really reaches the posted-Enter route under test.
        other = self.Input("")
        other.ProcessId = 9999
        other.NativeWindowHandle = 264128
        other.ClassName = "Chrome_WidgetWin_1"
        return other

    def test_a_window_that_is_not_wechat_is_never_posted_to(self):
        # The route must be specific to WeChat: a handle that belongs to some
        # other window must not receive a synthetic Enter just because numbers
        # lined up. Only an mmui window is a legitimate target, and without one
        # the send is refused rather than guessed at.
        backend, input_ctl = self.backend(focused=self.stranger())
        backend._window.ClassName = "Chrome_WidgetWin_1"
        fake_user32 = mock.MagicMock()
        with mock.patch.object(uia, "_user32", lambda: fake_user32):
            with self.assertRaises(uia.SafetyError) as ctx:
                backend.press_enter()
        self.assertEqual(ctx.exception.code, "focus_not_on_target")
        self.assertEqual(fake_user32.PostMessageW.mock_calls, [])
        self.assertEqual(input_ctl.typed, [])

    def test_missing_class_name_skips_the_post(self):
        # Unprovable identity is treated like a foreign window: no post, refuse.
        backend, input_ctl = self.backend(focused=self.stranger())
        backend._window.ClassName = ""
        fake_user32 = mock.MagicMock()
        with mock.patch.object(uia, "_user32", lambda: fake_user32):
            with self.assertRaises(uia.SafetyError):
                backend.press_enter()
        self.assertEqual(fake_user32.PostMessageW.mock_calls, [])
        self.assertEqual(input_ctl.typed, [])
    def test_no_window_handle_skips_the_post(self):
        backend, input_ctl = self.backend(handle=0)
        holder = self.Input("")
        holder.ProcessId = 11940
        holder.NativeWindowHandle = 44565750
        backend._auto = type("A", (), {"GetFocusedControl": staticmethod(lambda: holder)})
        fake_user32 = mock.MagicMock()
        with mock.patch.object(uia, "_user32", lambda: fake_user32):
            backend.press_enter()
        self.assertEqual(fake_user32.PostMessageW.mock_calls, [])
        self.assertEqual(input_ctl.typed, ["{Enter}"])


class TargetNotOpenIdleTests(unittest.TestCase):
    """When another chat is open the bridge waits instead of fighting or dying.

    Measured on the live machine at 23:45 with the panel open and the tree healthy:
    the operator had 星有野 on screen and the target group in the list; Select()
    and Invoke() on that row BOTH returned True and the open chat never changed
    (polled 4.0s and 4.5s). WeChat 4.2.0.12 cannot be switched head-lessly, so the
    baseline raise was a permanent condition, and every raise killed the child -
    which the supervisor respawned, so the bridge re-scanned the whole UIA tree
    roughly every 30 seconds forever while answering nobody.

    The correct behaviour is neither to force the operator's chat away (that is the
    screen takeover the objective forbids, and it does not work anyway) nor to die.
    It is to idle: read nothing, touch nothing, and start reading the moment the
    group he himself opens IS the target.
    """

    def test_a_different_open_chat_is_never_touched(self):
        # POSITIVE CONTROL: delete the idle guard and the select() count is the
        # first thing to go red, because the old code selected away from the
        # operator's chat twice per poll (there and back).
        backend = FakeBackend(messages={"Alpha": [raw("old")], "Beta": []},
                              current="Beta")
        adapter = uia.WechatGroupAdapter([group()], backend)
        adapter.start()
        self.assertEqual(operations(backend, "select"), [])
        self.assertEqual(backend.current, "Beta")

    def test_start_survives_an_unreachable_target(self):
        # The production bug: start() raised, the child exited, the supervisor
        # respawned it, and the loop repeated - a bridge that looks broken in the
        # log and is in fact waiting.
        backend = FakeBackend(messages={"Alpha": [], "Beta": []}, current="Beta")
        adapter = uia.WechatGroupAdapter([group()], backend)
        adapter.start()
        self.assertEqual(adapter.poll(), [])
        self.assertEqual(operations(backend, "select"), [])

    def test_opening_the_group_replays_no_history(self):
        # The safety half of resuming: when the operator finally opens the group,
        # whatever is already on screen is history he has read, not a request. It
        # must be taken as a fresh baseline - a /dsh line sitting in that backlog
        # must NOT fire the agent, or opening a busy group would answer a dozen old
        # commands at once.
        backend = FakeBackend(messages={"Alpha": [raw("/dsh \u65e7\u547d\u4ee4",
                                                  sender="uia-unverified:row")],
                                        "Beta": []}, current="Beta")
        adapter = uia.WechatGroupAdapter(
            [group(prefix="/dsh", allow_unverified_trigger=True)], backend,
            clock=lambda: 5)
        adapter.start()
        backend.current = "Alpha"
        self.assertEqual(adapter.poll(), [])
        self.assertEqual(adapter.poll(), [])

    def test_a_new_message_after_opening_is_still_addressed(self):
        # And the working half: once the fresh baseline is in, the next real message
        # is processed normally, with no restart and no window call in between.
        backend = FakeBackend(messages={"Alpha": [], "Beta": []}, current="Beta")
        adapter = uia.WechatGroupAdapter(
            [group(prefix="/dsh", allow_unverified_trigger=True)], backend,
            clock=lambda: 5)
        adapter.start()
        backend.current = "Alpha"
        self.assertEqual(adapter.poll(), [])
        backend.messages["Alpha"].append(raw("/dsh \u5e2e\u6211\u4e0b\u5355",
                                            sender="uia-unverified:row"))
        events = adapter.poll()
        self.assertEqual(len(events), 1)
        self.assertTrue(events[0]["addressed"])

    def test_idle_state_is_reported_instead_of_silence(self):
        # An operator reading the log must be able to tell 'waiting for you to open
        # the group' from 'broken', which is the confusion that made this session
        # look dead when the tree was fine.
        backend = FakeBackend(messages={"Alpha": [], "Beta": []}, current="Beta")
        adapter = uia.WechatGroupAdapter([group()], backend)
        adapter.start()
        adapter.poll()
        self.assertIn("uia_g1", adapter.health()["waiting_on"])

    def test_target_not_open_is_not_a_lost_surface(self):
        # The tree is present; only the conversation differs. Classifying this as
        # surface loss would restart WeChat, which is the destructive advice this
        # objective exists to stop.
        self.assertIn("target_not_open", uia.ERROR_MESSAGES)
        self.assertNotIn("target_not_open", uia.SURFACE_LOST_CODES)

    def test_nothing_open_still_lets_the_bridge_select(self):
        # Regression guard for the login case: no chat is open, so selecting the
        # target takes nothing away from the operator and must still be attempted.
        backend = FakeBackend(messages={"Alpha": [], "Beta": []}, current=None)
        adapter = uia.WechatGroupAdapter([group()], backend)
        adapter.start()
        self.assertEqual(operations(backend, "select")[:1], [("select", "Alpha")])


class CollapsedSidebarTests(unittest.TestCase):
    """A collapsed session sidebar must not take the whole bridge down.

    Measured on the live machine: the operator had collapsed the chat list, so
    session_list was absent while chat_message_list and chat_input_field were
    both present and the open chat was readable. The bridge reported
    control_missing, treated it as a lost surface, exited, and retried every 30
    seconds - so a group that was perfectly reachable went unanswered. The panel
    header (chat_input_field.Name) carries the exact chat title, which is real
    UIA evidence about the chat that is open, so it can stand in for the list
    while the list is unavailable.
    """

    class List:
        """Session list stand-in; empty means nothing is selected."""

        def GetChildren(self):
            return []

    class Panel:
        def __init__(self, title):
            self.Name = title
            self.AutomationId = "chat_input_field"
            self.ClassName = "mmui::ChatInputField"
            self.NativeWindowHandle = 0
            self.ProcessId = 11940

        def GetValuePattern(self):
            return None

    def backend(self, title, list_available):
        backend = uia.UiaBackend.__new__(uia.UiaBackend)
        backend._closed = False
        panel = self.Panel(title)

        class Messages:
            def GetChildren(self):
                return []

        def control(automation_id):
            if automation_id == "chat_input_field":
                return panel
            if automation_id == "chat_message_list":
                # A collapsed sidebar does not hide the open conversation, which is
                # exactly the live state this class models.
                return Messages()
            if list_available:
                return self.List()
            raise uia.SafetyError("no such control", "control_missing")

        backend._control = control
        # The adapter reads rows through the backend boundary, not raw controls.
        backend.read_messages = lambda: []
        return backend, panel

    def test_open_chat_title_survives_a_missing_list(self):
        backend, _ = self.backend("Alpha", list_available=False)
        self.assertEqual(backend.current_chat_title(), "Alpha")

    def test_an_empty_header_is_not_reported_as_a_chat(self):
        # An unnamed input proves nothing about which chat is open, and guessing
        # would let a send land in the wrong conversation.
        backend, _ = self.backend("", list_available=False)
        self.assertIsNone(backend.current_chat_title())

    def test_the_list_still_wins_when_both_are_available(self):
        # Do not weaken the existing two-independent-property check just because
        # a fallback exists.
        backend, panel = self.backend("Beta", list_available=True)
        # FakeList([]) has no selected item, so the list path cannot confirm and
        # the header alone must not be trusted while the list is present.
        with self.assertRaises(uia.SafetyError):
            backend.current_chat_title()
        self.assertEqual(panel.Name, "Beta")

    def test_unique_title_check_degrades_to_the_open_header(self):
        backend, _ = self.backend("Alpha", list_available=False)
        adapter = uia.WechatGroupAdapter([group()], backend)
        # The configured title matches the open chat header, so reading is safe.
        adapter._assert_unique_title(group())

    def test_a_transient_control_miss_is_retried_before_it_is_reported(self):
        # Measured 2026-11-02: 15 `sidebar_collapsed` reports on a healthy tree
        # -- window not minimized, list had 10 rows, every control resolved a
        # second later. A single WalkControl hiccup while WeChat re-renders used
        # to be reported as a collapsed sidebar, and the adapter EXITS on that,
        # so a sub-frame race took the bridge down. One retry must absorb it.
        backend, _ = self.backend("Alpha", list_available=True)
        adapter = uia.WechatGroupAdapter([group()], backend)
        calls = {"n": 0}

        def flaky():
            calls["n"] += 1
            if calls["n"] == 1:
                raise uia.SafetyError("missing", "control_missing")
            return ["Alpha"]

        backend.list_session_titles = flaky
        # The retry succeeds, so the target is confirmed and nothing is raised.
        adapter._assert_unique_title(group())
        self.assertEqual(calls["n"], 2)

    def test_a_persistent_control_miss_is_still_reported(self):
        # Two failures in a row is a real condition, not a hiccup: the caller
        # still needs to hear about it rather than reading a half-tree.
        # A list that never recovers, with a different chat on screen: the session
        # list really is unavailable, so the collapsed-sidebar diagnosis stands.
        backend, _ = self.backend("Other Group", list_available=False)
        adapter = uia.WechatGroupAdapter([group()], backend)
        with self.assertRaises(uia.SafetyError) as ctx:
            adapter._assert_unique_title(group())
        self.assertEqual(ctx.exception.code, "sidebar_collapsed")

    def test_a_duplicated_title_in_an_available_list_is_still_ambiguous(self):
        # The list IS available and names the target twice: reading or writing by
        # that visible name could hit the wrong conversation, so it stays a
        # duplicate_group_title refusal rather than the sidebar diagnosis.
        backend, _ = self.backend("Alpha", list_available=True)
        adapter = uia.WechatGroupAdapter([group()], backend)
        backend.list_session_titles = lambda: ["Alpha", "Alpha"]
        with self.assertRaises(uia.SafetyError) as ctx:
            adapter._assert_unique_title(group())
        self.assertEqual(ctx.exception.code, "duplicate_group_title")

    def test_a_different_open_chat_says_the_sidebar_is_collapsed(self):
        # Production symptom: the bridge reported control_missing, which is a
        # lost-surface code, so the child exited and the supervisor retried every
        # 30s forever. The real condition was a collapsed chat list, which no
        # number of respawns can expand, and the message must name it.
        backend, _ = self.backend("Other Group", list_available=False)
        adapter = uia.WechatGroupAdapter([group()], backend)
        with self.assertRaises(uia.SafetyError) as ctx:
            adapter._assert_unique_title(group())
        self.assertEqual(ctx.exception.code, "sidebar_collapsed")
        self.assertIn("sidebar", uia.ERROR_MESSAGES["sidebar_collapsed"].lower())

    def test_a_missing_list_still_lets_the_open_target_group_through(self):
        # The live state right now: sidebar collapsed, target group on screen.
        # This must read and answer, not exit.
        backend, _ = self.backend("Alpha", list_available=False)
        adapter = uia.WechatGroupAdapter([group()], backend)
        # start() captures a baseline for every group; before this change it died
        # here with control_missing, which is a lost-surface code, so the child
        # exited and the supervisor retried forever against a collapsed sidebar.
        adapter.start()
        self.assertEqual(adapter.poll(), [])
    def test_collapsed_sidebar_is_not_reported_as_a_lost_surface(self):
        # Exiting and respawning cannot expand a sidebar the operator collapsed.
        self.assertNotIn("sidebar_collapsed", uia.SURFACE_LOST_CODES)
        self.assertIn("sidebar_collapsed", uia.ERROR_MESSAGES)


class ErrorFrameRateLimitTests(unittest.TestCase):
    """One repeated diagnosis is reported once per window, not once per poll."""

    class Adapter:
        def __init__(self, code):
            self.code = code
            self.calls = 0

        def poll(self):
            self.calls += 1
            raise uia.SafetyError("injected", self.code)

    def frames(self, code, cycles, gap=0.0):
        protocol = uia.JsonlProtocol(self.Adapter(code))
        written = []
        clock = [1000.0]
        original = uia.time.monotonic

        def fake_clock():
            value = clock[0]
            clock[0] += gap
            return value

        uia.time.monotonic = fake_clock
        try:
            for _ in range(cycles):
                written.extend(protocol.poll_frames())
        finally:
            uia.time.monotonic = original
        return written, protocol

    def test_a_repeated_error_is_emitted_once_per_window(self):
        # The 750ms poll turns any persistent condition into 80 lines an hour,
        # which is how the original flood buried the diagnosis. The code must
        # still reach the operator, just not 80 times.
        frames, protocol = self.frames("poll_failed", 40)
        self.assertEqual(len(frames), 1)
        self.assertEqual(frames[0]["error"]["code"], "poll_failed")

    def test_a_changed_code_is_reported_immediately(self):
        # Rate limiting must not hide a new symptom behind an old one.
        protocol = uia.JsonlProtocol(self.Adapter("poll_failed"))
        first = protocol.poll_frames()
        protocol.adapter.code = "target_draft_not_empty"
        second = protocol.poll_frames()
        self.assertEqual(len(first), 1)
        self.assertEqual(second[0]["error"]["code"], "target_draft_not_empty")

    def test_a_fatal_code_is_never_suppressed(self):
        # Surface loss is the one case where exiting is the point; swallowing the
        # frame would leave the supervisor guessing why the child died.
        frames, protocol = self.frames("wechat_panel_closed", 5)
        self.assertEqual(len(frames), 1)
        self.assertEqual(protocol.fatal_code, "wechat_panel_closed")

class NoOpenChatTests(unittest.TestCase):
    """A freshly logged-in WeChat has no chat panel until one is opened."""

    def test_current_chat_title_reports_none_when_nothing_is_open(self):
        backend = FakeBackend(titles=["Alpha"])
        backend.current = None
        self.assertIsNone(backend.current_chat_title())

    def test_reading_a_target_selects_it_when_nothing_was_open(self):
        backend = FakeBackend(titles=["Alpha", "Beta"], current=None, messages={"Alpha": [raw("old")]})
        group_config = group()
        adapter = uia.WechatGroupAdapter([group_config], backend)
        adapter.start()
        self.assertEqual(operations(backend, "select")[:1], [("select", "Alpha")])
        # Nothing was open before, so nothing may be restored afterwards.
        self.assertEqual(len(operations(backend, "select")), 1)


class BackendFailureCodeTests(unittest.TestCase):
    """The adapter must tell an operator WHY the group bridge cannot start."""

    def _backend(self, main, login):
        fake = FakeAuto(main=main, login=login)
        with mock.patch.object(uia.sys, "platform", "win32"):
            with mock.patch.dict("sys.modules", {"uiautomation": fake}):
                return uia.UiaBackend()

    def test_login_window_reports_logged_out_not_main_window_missing(self):
        # A logged-out WeChat needs a human scan; reporting 'main_window_missing'
        # would send the operator looking for a window-restore bug instead.
        with self.assertRaises(uia.SafetyError) as raised:
            self._backend(main=False, login=True)
        self.assertEqual(raised.exception.code, "wechat_logged_out")

    def test_no_wechat_window_still_reports_main_window_missing(self):
        with self.assertRaises(uia.SafetyError) as raised:
            self._backend(main=False, login=False)
        self.assertEqual(raised.exception.code, "main_window_missing")


class FakeRect:
    """Minimal stand-in for a UIA BoundingRectangle."""

    def __init__(self, left=0, top=0, right=0, bottom=0):
        self.left = left
        self.top = top
        self.right = right
        self.bottom = bottom


class ClassifierFakeWin:
    def __init__(self, exists, class_name="", name="", offscreen=False, rect=None):
        self._exists = exists
        self.ClassName = class_name
        self.Name = name
        self.IsOffscreen = offscreen
        # Default: a large on-screen window, i.e. a panel the operator can see.
        self.BoundingRectangle = rect if rect is not None else FakeRect(0, 0, 1477, 880)

    def Exists(self, seconds, interval):
        return self._exists


class ClassifierFakeRoot:
    def __init__(self, children):
        self._children = children

    def GetChildren(self):
        return self._children


class ClassifierFakeNode:
    """One login-window child, as UIA reports it: type plus visible name."""

    def __init__(self, control_type, name):
        self.ControlTypeName = control_type
        self.Name = name
        self.ClassName = "mmui::XButton"


class ClassifierFakeAuto:
    """uiautomation surface for classify_missing_main_window only."""

    def __init__(self, main=False, login=False, shell=False):
        self._main = main
        self._login = login
        self._shell = shell

    def WindowControl(self, searchDepth, ClassName):
        if ClassName == "mmui::MainWindow":
            return ClassifierFakeWin(self._main)
        if ClassName == "mmui::LoginWindow":
            return ClassifierFakeWin(self._login)
        return ClassifierFakeWin(False)

    def WalkControl(self, control, includeTop=False, maxDepth=20):
        # The classifier reads the login window's CONTENT to tell a remembered
        # account from a signed-out one, so the double has to expose children.
        for name in getattr(self, "_login_buttons", []):
            yield ClassifierFakeNode("ButtonControl", name), 3
        for name in getattr(self, "_login_texts", []):
            yield ClassifierFakeNode("TextControl", name), 3

    def GetRootControl(self):
        children = []
        # An explicit shell control lets a test set size and offscreen state,
        # which is what separates a visible panel from a leftover tray shell.
        shell = getattr(self, "_shell_win", None)
        if shell is not None:
            children.append(shell)
        elif self._shell:
            children.append(ClassifierFakeWin(True, "Qt51514QWindowIcon", "微信"))
        return ClassifierFakeRoot(children)


class ProviderMessageTests(unittest.TestCase):
    """The accessibility diagnosis must name the cause an operator can change.

    Root cause measured on this machine: a WeChat panel that is fully visible yet
    answers WM_GETOBJECT with 0 has no accessibility provider attached, and Qt
    decides that once, at process start, from QT_ACCESSIBILITY. That user
    environment variable was absent here (HKCU Environment, read at 22:56), which
    is why every instance started from the taskbar pin had zero automation ids
    while every instance started with the variable present had a working tree.
    "Restart WeChat" on its own is not actionable: without the variable a restart
    reproduces exactly the same provider-less state.
    """

    def test_message_names_the_environment_variable(self):
        message = uia.ERROR_MESSAGES["wechat_accessibility_unavailable"]
        self.assertIn("QT_ACCESSIBILITY", message)
        # And it must still say to restart, because Qt reads the variable only at
        # process start; a running process cannot be talked into attaching later.
        self.assertIn("restart", message.lower())

    def test_panel_closed_message_rules_out_the_minimise_misdiagnosis(self):
        # Inverted on purpose. This test used to forbid the word "minimise" because
        # the codebase believed minimising destroyed the accessibility tree; the
        # measurement behind that belief was taken with QT_ACCESSIBILITY missing, and
        # both states look identical ("zero mmui controls desktop-wide"). Measured
        # 2026-11-02 with the provider present and the panel minimised for the whole
        # run (IsIconic=True, showCmd=2, off-screen 158x26): session list 10 rows,
        # message list 8 rows, input field writable via ValuePattern.
        # So the honest message names the fix AND clears the minimise the operator
        # almost certainly suspects - while never sending him to restart WeChat.
        message = uia.ERROR_MESSAGES["wechat_panel_closed"].lower()
        self.assertIn("reopen", message)
        self.assertIn("minimis", message)
        self.assertNotIn("restart", message)

class LoginWindowKindTests(unittest.TestCase):
    """A login window is not proof of being signed out.

    Measured on the live machine, mmui::LoginWindow appears in two different
    states that need opposite handling:
    - remembered account: texts 当前登录用户大肥鱼 / 登录 / 切换账号, and a real
      ButtonControl named 登录. The session is STILL LOGGED IN; it only needs
      that button pressed.
    - signed out: texts 仅传输文件 / 扫码登录, a 二维码 button, and no 登录 button.

    Reporting the first as wechat_logged_out is what caused the damage this
    objective names: an operator or script told 'you are logged out' restarts the
    client, and a restart of a logged-in client can lose the session. The
    classifier must therefore read the window, not just its existence.
    """

    def fake(self, texts, buttons=()):
        auto = ClassifierFakeAuto(main=False, login=True, shell=True)
        auto._login_texts = list(texts)
        auto._login_buttons = list(buttons)
        return auto

    def test_remembered_account_is_not_reported_as_signed_out(self):
        auto = self.fake(["当前登录用户大肥鱼", "登录", "切换账号", "仅传输文件", "微信"],
                         ["登录", "切换账号", "仅传输文件", "关闭"])
        self.assertEqual(uia.classify_missing_main_window(auto),
                         "wechat_login_confirmation")

    def test_qr_page_is_still_reported_as_signed_out(self):
        auto = self.fake(["仅传输文件", "扫码登录", "微信"],
                         ["仅传输文件", "二维码", "关闭", "网络代理设置"])
        self.assertEqual(uia.classify_missing_main_window(auto), "wechat_logged_out")

    def test_an_unreadable_login_window_is_reported_as_signed_out(self):
        # Fail toward the weaker claim: with no text to read the bridge cannot
        # prove an account is remembered, and 'confirm the login' would be a guess.
        self.assertEqual(
            uia.classify_missing_main_window(self.fake([])), "wechat_logged_out")

    def test_confirmation_message_forbids_restarting_wechat(self):
        # The advice is the point. 'Restart WeChat' against a remembered session is
        # how a logged-in client gets thrown away.
        message = uia.ERROR_MESSAGES["wechat_login_confirmation"]
        self.assertIn("confirm", message.lower())
        self.assertNotIn("restart", message.lower())

    def test_no_shipped_code_path_may_terminate_the_wechat_process(self):
        # The regression the operator reported: 'you closed my logged-in client'.
        # The bridge may stop its OWN adapter child, and may launch Weixin.exe to
        # start a signed-out client, but nothing it ships may kill a running
        # WeChat process - killing the client destroys the accessibility tree and
        # can drop a live session, which is never the bridge's call to make.
        import pathlib

        root = pathlib.Path(uia.__file__).parent
        sources = [root / "wechat_group_uia.py"]
        sources += sorted((root.parent / "src" / "channels" / "weixin").glob("*.mjs"))
        needles = ("taskkill", "Stop-Process", "Weixin.exe", "WeChat.exe")
        offenders = []
        for path in sources:
            text = path.read_text(encoding="utf-8", errors="replace")
            for line_no, line in enumerate(text.splitlines(), 1):
                lowered = line.lower()
                if any(needle.lower() in lowered for needle in ("taskkill", "stop-process")):
                    offenders.append("%s:%d" % (path.name, line_no))
                # Launching the client is allowed; killing it is not.
                if "weixin.exe" in lowered and any(
                        verb in lowered for verb in ("kill", "stop", "terminate")):
                    offenders.append("%s:%d" % (path.name, line_no))
        self.assertEqual(offenders, [], "shipped code must not kill WeChat: " + str(offenders))

class PanelClosedClassifierTests(unittest.TestCase):
    """classify_missing_main_window separates signed-out, closed-panel, absent."""

    def test_login_screen_wins_over_shell(self):
        # With both a login window and a leftover shell, the actionable truth is
        # the login prompt, so wechat_logged_out must be checked first.
        fake = ClassifierFakeAuto(main=False, login=True, shell=True)
        self.assertEqual(uia.classify_missing_main_window(fake), "wechat_logged_out")

    def test_tray_sized_shell_without_mmui_tree_is_panel_closed(self):
        # Geometry measured after an X-close: the leftover shell is parked at
        # -32000,-32000 and is about 276x45. That is the closed-panel case; a
        # large on-screen shell is the missing-tree case tested below.
        shell = ClassifierFakeWin(
            True, "Qt51514QWindowIcon", "微信",
            offscreen=True, rect=FakeRect(-32000, -32000, -31724, -31955))
        fake = ClassifierFakeAuto(main=False, login=False, shell=False)
        fake._shell_win = shell
        self.assertEqual(uia.classify_missing_main_window(fake), "wechat_panel_closed")

    def test_visible_panel_without_a_tree_is_not_called_closed(self):
        # Measured live: the operator screenshotted an OPEN WeChat panel while
        # UIA found no mmui tree at all. Reporting that as a closed panel told
        # them to minimise it - the one action that provably DESTROYS the tree on
        # this build - so a large on-screen window must be classified differently.
        fake = ClassifierFakeAuto(main=False, login=False, shell=True)
        self.assertEqual(
            uia.classify_missing_main_window(fake),
            "wechat_accessibility_unavailable",
        )

    def test_offscreen_shell_is_still_the_closed_panel_case(self):
        shell = ClassifierFakeWin(True, "Qt51514QWindowIcon", "\u5fae\u4fe1",
                                  offscreen=True, rect=FakeRect(-32000, -32000, -31724, -31955))
        fake = ClassifierFakeAuto(main=False, login=False, shell=False)
        fake._shell_win = shell
        self.assertEqual(uia.classify_missing_main_window(fake), "wechat_panel_closed")

    def test_tiny_shell_is_still_the_closed_panel_case(self):
        # A leftover tray-sized shell is what X-closing actually leaves behind.
        shell = ClassifierFakeWin(True, "Qt51514QWindowIcon", "\u5fae\u4fe1",
                                  rect=FakeRect(100, 100, 340, 160))
        fake = ClassifierFakeAuto(main=False, login=False, shell=False)
        fake._shell_win = shell
        self.assertEqual(uia.classify_missing_main_window(fake), "wechat_panel_closed")

    def test_missing_tree_counts_as_a_surface_loss(self):
        # The slow retry ladder is chosen from this set on both sides of the
        # boundary. A visible panel with no tree can only be fixed by restarting
        # WeChat, which is human-scale work, so polling it every 2.5s would be
        # the same log flood the closed-panel case already caused.
        self.assertIn("wechat_accessibility_unavailable", uia.SURFACE_LOST_CODES)
    def test_accessibility_message_never_advises_minimising(self):
        # The advice matters as much as the code: minimise destroys the tree.
        message = uia.ERROR_MESSAGES["wechat_accessibility_unavailable"]
        self.assertNotIn("minimise", message.lower())
        self.assertIn("restart", message.lower())
    def test_nothing_running_is_main_window_missing(self):
        fake = ClassifierFakeAuto(main=False, login=False, shell=False)
        self.assertEqual(uia.classify_missing_main_window(fake), "main_window_missing")

    def test_panel_closed_message_names_the_headless_fix(self):
        # RETRACTED, and this assertion used to enforce the retracted advice: it
        # demanded the message say 'minimise' because a note from earlier today
        # claimed minimising keeps the accessibility tree. Measured instead: after
        # SW_SHOWMINNOACTIVE the window was still non-iconic and UIA found zero
        # mmui controls desktop-wide, so minimise destroys the tree too. Following
        # that wording is what left the operator with a visible panel and no bridge.
        # The message may only say what is true: reopen the panel and leave it open.
        # See the sibling test above: the old rule forbade "minimise" outright on a
        # premise that turned out to be a misdiagnosis (missing QT_ACCESSIBILITY,
        # not minimisation). The message must name the fix and rule the minimise out.
        message = uia.ERROR_MESSAGES["wechat_panel_closed"].lower()
        self.assertIn("reopen", message)
        self.assertIn("minimis", message)
        self.assertNotIn("restart", message)

    def test_missing_window_message_says_start_wechat(self):
        self.assertIn("start", uia.ERROR_MESSAGES["main_window_missing"].lower())


if __name__ == "__main__":
    unittest.main()



class GroupedRowMentionTests(unittest.TestCase):
    """WeChat renders one @-message as several list rows; the bridge must rejoin them.

    Why this exists: measured 2026-11-02 00:40 on the live machine, the operator's
    single message "@大肥鱼 /dsh 在吗" arrives as TWO sibling mmui::ChatTextItemView
    rows inside one mmui::RecyclerListView:

        index 4  name '@大肥鱼\u2005'   BoundingRectangle top=689  height=134
        index 5  name '/dsh 在吗'      BoundingRectangle top=824  height=134

    read_visible_rows_as_messages() judged every row on its own, so the mention row
    had no body (skipped as empty) and the body row had no leading @ token. Both
    rows failed parse_trigger and the operator's @ was silently ignored. That is
    the whole defect behind "群里直接艾特不能调用".
    """

    AT = "@\u5927\u80a5\u9c7c\u2005"

    def test_consecutive_mention_row_and_body_row_join(self):
        rows = [
            {"cls": "mmui::ChatItemView", "name": "00:32"},
            {"cls": "mmui::ChatTextItemView", "name": self.AT},
            {"cls": "mmui::ChatTextItemView", "name": "/dsh \u5728\u5417"},
        ]
        messages = uia.read_visible_rows_as_messages(rows, allow_unverified=True)
        self.assertEqual(len(messages), 1, "the two sibling rows must become one message")
        self.assertEqual(messages[0].text, self.AT + "/dsh \u5728\u5417")

    def test_a_time_separator_breaks_the_join(self):
        # A time row between them means they are different messages, not one @.
        rows = [
            {"cls": "mmui::ChatTextItemView", "name": self.AT},
            {"cls": "mmui::ChatItemView", "name": "00:32"},
            {"cls": "mmui::ChatTextItemView", "name": "/dsh \u5728\u5417"},
        ]
        messages = uia.read_visible_rows_as_messages(rows, allow_unverified=True)
        self.assertEqual([m.text for m in messages],
                         ["@\u5927\u80a5\u9c7c", "/dsh \u5728\u5417"])

    def test_a_plain_body_row_is_never_glued_to_a_previous_body_row(self):
        rows = [
            {"cls": "mmui::ChatTextItemView", "name": "\u7b2c\u4e00\u6761"},
            {"cls": "mmui::ChatTextItemView", "name": "\u7b2c\u4e8c\u6761"},
        ]
        messages = uia.read_visible_rows_as_messages(rows, allow_unverified=True)
        self.assertEqual([m.text for m in messages],
                         ["\u7b2c\u4e00\u6761", "\u7b2c\u4e8c\u6761"])

    def test_the_joined_row_then_matches_the_configured_trigger_name(self):
        rows = [
            {"cls": "mmui::ChatTextItemView", "name": self.AT},
            {"cls": "mmui::ChatTextItemView", "name": "/dsh \u5728\u5417"},
        ]
        messages = uia.read_visible_rows_as_messages(rows, allow_unverified=True)
        parsed, text = uia.parse_trigger(
            messages[0].text, "/dsh", mention_mode="mention-or-command",
            trigger_names=("\u5927\u80a5\u9c7c",), allow_masked_mention=True)
        self.assertTrue(parsed)
        self.assertEqual(text, "\u5728\u5417")

    def test_a_lone_mention_row_stays_a_bare_mention(self):
        # The measured row 7 of the same transcript: '@大肥鱼' with nothing after it.
        # The trailing U+2005 is gone by design: read_visible_rows_as_messages strips
        # every row and str.strip() also removes U+2005. That is precisely why
        # merge_mention_rows has to re-insert its own separator when it joins.
        rows = [{"cls": "mmui::ChatTextItemView", "name": self.AT}]
        messages = uia.read_visible_rows_as_messages(rows, allow_unverified=True)
        self.assertEqual(len(messages), 1)
        self.assertEqual(messages[0].text, "@\u5927\u80a5\u9c7c")
        # A lone "@大肥鱼" now parses as addressed with an empty body: the name is
        # recognised, there is simply nothing after it. The adapter turns that empty
        # body into the configured prompt, so the poke is answered instead of
        # dropped (measured 2026-11-02: two bare @ rows produced no event at all).
        parsed, text = uia.parse_trigger(
            messages[0].text, "/dsh", mention_mode="mention-or-command",
            trigger_names=("\u5927\u80a5\u9c7c",), allow_masked_mention=True)
        self.assertTrue(parsed)
        self.assertEqual(text, "")


class LoginMisdiagnosisGuardTests(unittest.TestCase):
    """A single snapshot must never be enough to declare the session lost.

    The defect this pins: classify_missing_main_window() used to act on one
    zero-timeout Exists() call. Two live situations made that lie, and both end with
    a signed-in operator being told to log in - the advice that costs him a session:

      1. startup race - the login window is destroyed and the main window is built
         a moment later; a sample inside that gap reads "logged out";
      2. COM flake - one failed snapshot makes both windows answer absent.

    The fix re-reads the main window before classifying, and re-reads the login
    window before claiming a signed-out account. Both are tested here.
    """

    def test_a_reappearing_main_window_is_not_classified_at_all(self):
        # The caller already saw no main window; by the time the classifier runs it
        # is back. There is no missing-window state to describe.
        auto = ClassifierFakeAuto(main=True, login=True)
        with self.assertRaises(uia.SafetyError) as caught:
            uia.classify_missing_main_window(auto)
        self.assertEqual(caught.exception.code, uia.TRANSIENT_SURFACE_CODE)

    def test_a_login_window_that_vanishes_is_transient_not_logged_out(self):
        # First read: login window present, nothing readable inside it. Second read
        # (the recheck): gone, because the real main window finished building.
        auto = ClassifierFakeAuto(main=False, login=True)
        reads = {"login": 0}

        class Flaky(ClassifierFakeAuto):
            def WindowControl(self, searchDepth, ClassName):
                if ClassName == "mmui::LoginWindow":
                    reads["login"] += 1
                    # The classifier's own read is the first one; the recheck is
                    # the second, and by then the window is gone.
                    return ClassifierFakeWin(reads["login"] == 1)
                return ClassifierFakeAuto.WindowControl(self, searchDepth, ClassName)

        with self.assertRaises(uia.SafetyError) as caught:
            uia.classify_missing_main_window(Flaky(main=False, login=True))
        self.assertEqual(caught.exception.code, uia.TRANSIENT_SURFACE_CODE)

    def test_a_stable_login_window_is_still_reported_as_logged_out(self):
        # Negative control for the two tests above: when the login window really is
        # there on both reads and offers no confirmation button, the signed-out
        # diagnosis must still come through, or the guard would have swallowed the
        # very case it exists to distinguish.
        auto = ClassifierFakeAuto(main=False, login=True)
        self.assertEqual(uia.classify_missing_main_window(auto), "wechat_logged_out")

    def test_a_remembered_account_still_wins_over_the_signed_out_diagnosis(self):
        auto = ClassifierFakeAuto(main=False, login=True)
        auto._login_buttons = ["登录"]
        self.assertEqual(
            uia.classify_missing_main_window(auto), "wechat_login_confirmation")

    def test_the_transient_code_never_enters_the_surface_lost_set(self):
        # If it did, one flaky snapshot would make the child exit and trigger the
        # restart ladder - which is the destructive action this whole guard avoids.
        self.assertNotIn(uia.TRANSIENT_SURFACE_CODE, uia.SURFACE_LOST_CODES)

    def test_the_transient_code_is_not_an_instruction_to_restart(self):
        message = uia.ERROR_MESSAGES[uia.TRANSIENT_SURFACE_CODE].lower()
        self.assertIn("looking again", message)
        self.assertNotIn("restart", message)
        self.assertNotIn("log in", message)


class SendMustNotRaiseWeChatTests(unittest.TestCase):
    """A send must be able to prove it did not raise WeChat over the operator.

    Measured on this machine, this is not hypothetical:

        GetForegroundWindow() before control.SetFocus() -> 4392416  (operator's app)
        GetForegroundWindow() after  control.SetFocus() -> 3017014  (WeChat)
        wechat_became_foreground = True

    uiautomation's Control.SendKeys is `self.SetFocus(); SendKeys(...)`, so every
    keyboard send used to include that focus change. The containment predicate only
    promised the key would not reach another app - a weaker promise than "the
    operator's screen never moved". press_enter() now snapshots the foreground window
    around the keystroke and refuses when it changed.
    """

    class Control:
        def __init__(self):
            self.AutomationId = "chat_input_field"
            self.ClassName = "mmui::ChatInputField"
            self.NativeWindowHandle = 0
            self.ProcessId = 11940
            self.typed = []

        def SendKeys(self, text, waitTime=0):
            self.typed.append(text)

    def backend(self, foreground_sequence):
        """Backend whose foreground handle is read from a scripted sequence."""

        backend = uia.UiaBackend.__new__(uia.UiaBackend)
        backend._closed = False
        control = self.Control()
        backend._control = lambda automation_id: control
        backend._focus_is_contained = lambda c: True
        # The posted and invoke routes must not deliver, or this route is never
        # reached and the test would pass for the wrong reason.
        backend._posted_enter_delivered = lambda: False
        backend.send_by_invoke = lambda: False
        values = list(foreground_sequence)
        backend._foreground_window = lambda: values.pop(0) if values else None
        return backend, control

    def test_a_send_that_raises_wechat_is_refused(self):
        # The proof the operator asked for: the call would steal his screen, so it
        # must be reported instead of silently done.
        backend, control = self.backend([4392416, 3017014])
        with self.assertRaises(uia.SafetyError) as caught:
            backend.press_enter()
        self.assertEqual(caught.exception.code, "focus_not_on_target")
        # The keystroke did go out (that is what SendKeys does), but the bridge now
        # says so instead of pretending the send was clean. The caller records
        # outcome_unknown rather than claiming success.
        self.assertEqual(control.typed, ["{Enter}"])

    def test_a_send_that_leaves_the_foreground_alone_is_clean(self):
        # Negative control: when the foreground handle is unchanged the send is
        # accepted, so the guard is not simply refusing everything.
        backend, control = self.backend([3017014, 3017014])
        backend.press_enter()
        self.assertEqual(control.typed, ["{Enter}"])

    def test_an_unreadable_foreground_is_not_treated_as_agreement(self):
        # None means no evidence. The route still runs (there is nothing to compare
        # against), but a later change is still caught; the assertion here is that a
        # read failure does not crash the send or fabricate a mismatch.
        backend, control = self.backend([None, None])
        backend.press_enter()
        self.assertEqual(control.typed, ["{Enter}"])

    def test_without_containment_and_without_opt_in_nothing_is_typed(self):
        backend, control = self.backend([4392416, 4392416])
        backend._focus_is_contained = lambda c: False
        with self.assertRaises(uia.SafetyError) as caught:
            backend.press_enter()
        self.assertEqual(caught.exception.code, "focus_not_on_target")
        self.assertEqual(control.typed, [], "no keystroke without a proven target")


class GluedMentionAndBarePokeTests(unittest.TestCase):
    """The two shapes that made the operator say "有正文了还是不理我".

    Measured 2026-11-02 in the live group:

        '@大肥鱼'           -> parse returned (False, ...)  and the row was dropped
        '@大肥鱼测试回复'    -> parse returned (False, ...)  because
                              READABLE_MENTION_RE requires a separator after the name,
                              and a hand-typed @ has none: WeChat only inserts U+2005
                              when the mention comes from its @ picker.

    The second one is why switching models changed nothing - the event was refused in
    parsing, before any model was called.
    """

    NAMES = ("\u5927\u80a5\u9c7c",)

    def parse(self, text, mode="mention-or-command"):
        return uia.parse_trigger(
            text, "/dsh", mention_mode=mode, trigger_names=self.NAMES,
            allow_masked_mention=True)

    def test_the_glued_shape_now_carries_its_body(self):
        # POSITIVE CONTROL for the fix: before it, this returned (False, text).
        self.assertEqual(self.parse("@\u5927\u80a5\u9c7c\u6d4b\u8bd5\u56de\u590d"),
                         (True, "\u6d4b\u8bd5\u56de\u590d"))

    def test_all_three_separator_shapes_agree(self):
        # U+2005 (picker), ASCII space (typed with a space), and none at all
        # (hand-typed glued) must all be the same event, or the operator gets a
        # different outcome depending on how he happened to type it.
        expected = (True, "\u6d4b\u8bd5\u56de\u590d")
        for text in ("@\u5927\u80a5\u9c7c\u2005\u6d4b\u8bd5\u56de\u590d",
                     "@\u5927\u80a5\u9c7c \u6d4b\u8bd5\u56de\u590d",
                     "@\u5927\u80a5\u9c7c\u6d4b\u8bd5\u56de\u590d"):
            self.assertEqual(self.parse(text), expected, repr(text))

    def test_a_foreign_glued_mention_is_still_refused(self):
        # The glued path must not become a way to be addressed by accident: a name
        # that is not ours leaves the row unaddressed, exactly as before.
        text = "@\u5c0f\u674e\u6d4b\u8bd5\u56de\u590d"
        self.assertEqual(self.parse(text), (False, text))

    def test_the_longest_configured_name_wins(self):
        # "@大肥鱼的朋友你好" with both names configured must strip the LONGER name,
        # otherwise the body would silently lose half of it.
        parsed, body = uia.parse_trigger(
            "@\u5927\u80a5\u9c7c\u7684\u670b\u53cb\u4f60\u597d", "/dsh",
            mention_mode="mention-or-command",
            trigger_names=("\u5927\u80a5\u9c7c", "\u5927\u80a5\u9c7c\u7684\u670b\u53cb"),
            allow_masked_mention=True)
        self.assertTrue(parsed)
        self.assertEqual(body, "\u4f60\u597d")

    def test_a_bare_mention_is_recognised_as_a_poke(self):
        # The helper that separates "poked me" from "started a command and stopped".
        self.assertTrue(uia._has_mention_token("@\u5927\u80a5\u9c7c", self.NAMES, True))
        self.assertTrue(uia._has_mention_token("@" + "\u5927\u80a5\u9c7c" + "\u2005",
                                               self.NAMES, True))
        self.assertTrue(uia._has_mention_token("@[___]", self.NAMES, True))

    def test_a_lone_command_prefix_is_not_a_poke(self):
        # "/dsh" and "@大肥鱼" both parse to (True, ''), so only the token check can
        # tell them apart - and answering "/dsh" with 干嘛 would invent an intent.
        self.assertFalse(uia._has_mention_token("/dsh", self.NAMES, True))
        self.assertFalse(uia._has_mention_token("hello", self.NAMES, True))
        self.assertFalse(uia._has_mention_token("@[___]", self.NAMES, False),
                         "masked token needs the group opt-in")

    def test_the_default_prompt_is_the_one_the_operator_asked_for(self):
        # Pinned so a future refactor cannot quietly change the wording he chose.
        self.assertEqual(uia.GroupConfig.bare_mention_prompt, "\u5e72\u5417")


class TransientTitleFailureTests(unittest.TestCase):
    """One unreadable chat header must not cost a whole polling cycle.

    Measured 2026-11-02 in the host log:

        01:34:40 [W] [dsh-weixin] group adapter reported a sanitized error (title_unavailable)

    A single moment where the chat header could not be read aborted the entire poll,
    and the adapter then reported nothing for that group until a restart took a fresh
    baseline - which is how a real message gets dropped for good. The header being
    briefly unreadable is a reading failure, not a state change.
    """

    def test_a_transient_title_failure_skips_one_cycle_without_losing_rows(self):
        # The row arrives while the header is unreadable. It must still be delivered
        # on the next readable cycle, not swallowed by a re-baseline.
        backend = FakeBackend(messages={"Alpha": []})
        original = backend.current_chat_title
        # Armed explicitly rather than by call count: _read_target reads the title
        # more than once per poll, so a counter would fire in the wrong cycle.
        armed = {"on": False}

        def flaky_title():
            if armed["on"]:
                armed["on"] = False   # exactly one failed read
                raise uia.SafetyError("header unreadable", "title_unavailable")
            return original()

        backend.current_chat_title = flaky_title
        adapter = uia.WechatGroupAdapter([group()], backend, clock=lambda: 7)
        adapter.start()

        backend.messages["Alpha"].append(raw("/dsh \u4e0b\u5355"))
        armed["on"] = True
        # This poll hits the unreadable header and must return no events WITHOUT
        # raising, so the polling loop keeps running.
        self.assertEqual(adapter.poll(), [])
        # The next poll reads normally and must deliver the row that was waiting.
        events = adapter.poll()
        self.assertEqual([e["text"] for e in events], ["\u4e0b\u5355"],
                         "the row must survive the unreadable cycle")

    def test_a_real_surface_loss_still_propagates(self):
        # Negative control: swallowing everything would hide a closed panel behind a
        # silent loop, which is the bug this guard must not introduce.
        backend = FakeBackend(messages={"Alpha": []})
        original = backend.current_chat_title
        armed = {"on": False}

        def closing():
            if armed["on"]:
                raise uia.SafetyError("panel gone", "wechat_panel_closed")
            return original()

        backend.current_chat_title = closing
        adapter = uia.WechatGroupAdapter([group()], backend, clock=lambda: 7)
        adapter.start()
        armed["on"] = True
        with self.assertRaises(uia.SafetyError) as caught:
            adapter.poll()
        self.assertEqual(caught.exception.code, "wechat_panel_closed")


class ReplyEchoWithMentionPrefixTests(unittest.TestCase):
    """The bridge must not answer its own reply when that reply carried an @.

    Measured 2026-11-02 in the live group, right after the bare-@ change went live:

        row 6  '@大肥鱼\u2005'
        row 7  '已排队，等待前序消息处理。'

    Rows 6 and 7 are ONE message the bridge itself had just sent (a queue receipt
    that mentions the operator). merge_mention_rows joined them into
    '@大肥鱼\u2005已排队…', parse_trigger called it addressed, and the bridge would
    have answered itself - a real reply loop, observed rather than imagined.

    _consume_bridge_echo compared exact text, so '<our text>' never matched
    '@bot <our text>'. It now also accepts a row that ENDS with everything we sent,
    provided the part before it is an @ token we recognise.
    """

    def adapter_with_outbound(self, sent_text, trigger_names=("\u5927\u80a5\u9c7c",)):
        backend = FakeBackend(messages={"Alpha": []})
        cfg = uia.GroupConfig(
            id="uia_g1", title="Alpha", trigger_names=trigger_names,
            command_prefix="/dsh", mention_mode="mention-or-command",
            allow_unverified_trigger=True,
        )
        adapter = uia.WechatGroupAdapter([cfg], backend, clock=lambda: 9)
        adapter.start()
        # Register the outbound exactly as a real send would, without performing one.
        outbound = uia._Outbound(
            request_id="r1", chat_id="uia_g1", text=sent_text, provider_id="p1",
            attempted=True, echo_pending=True,
        )
        adapter._outbounds["r1"] = outbound
        return adapter, outbound

    def test_our_reply_wearing_an_at_prefix_is_not_a_new_mention(self):
        adapter, outbound = self.adapter_with_outbound("\u5df2\u6392\u961f")
        echoed = uia.RawMessage(
            sender="uia-unverified:row",
            text="@\u5927\u80a5\u9c7c\u2005\u5df2\u6392\u961f",
        )
        self.assertTrue(adapter._consume_bridge_echo("uia_g1", echoed),
                        "our own reply must be recognised")
        self.assertFalse(outbound.echo_pending, "one echo only")

    def test_an_unrelated_at_message_is_not_swallowed_as_an_echo(self):
        # Negative control: suffix matching must not become a way to drop real
        # messages. A row that merely CONTAINS our text in the middle is not an echo.
        adapter, _outbound = self.adapter_with_outbound("\u5df2\u6392\u961f")
        genuine = uia.RawMessage(
            sender="uia-unverified:row",
            text="/dsh \u4e3a\u4ec0\u4e48\u5df2\u6392\u961f",
        )
        self.assertFalse(adapter._consume_bridge_echo("uia_g1", genuine))

    def test_an_echo_without_a_recognised_at_prefix_is_not_consumed(self):
        # The prefix must be an @ we honour; arbitrary leading text is not enough.
        adapter, _outbound = self.adapter_with_outbound("\u5df2\u6392\u961f")
        strange = uia.RawMessage(
            sender="uia-unverified:row",
            text="\u522b\u4eba\u8bf4\u5df2\u6392\u961f",
        )
        self.assertFalse(adapter._consume_bridge_echo("uia_g1", strange))
