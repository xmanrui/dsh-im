import io
import json
import os
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


def group(chat_id="uia_g1", title="Alpha", allow_self=False, prefix="/dsh"):
    return uia.GroupConfig(
        id=chat_id,
        title=title,
        trigger_names=("Nickname",),
        command_prefix=prefix,
        allow_self=allow_self,
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
        self.adapter.start()
        self.backend.messages["Alpha"].extend([raw("/dsh"), raw("   ")])
        self.assertEqual(self.adapter.poll(), [])

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
        backend = FakeBackend(current="Beta", messages={"Beta": [raw("/dsh secret")]})
        backend.wrong_selection = "Beta"
        adapter = uia.WechatGroupAdapter([group()], backend)
        with self.assertRaises(uia.SafetyError):
            adapter.start()
        self.assertEqual(operations(backend, "read_messages"), [])

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
        groups = [group(), group(chat_id="uia_g2", title="Beta")]
        backend = FakeBackend(messages={"Alpha": [], "Beta": []})
        adapter = uia.WechatGroupAdapter(groups, backend, clock=lambda: 5)
        adapter.start()
        backend.messages["Alpha"].append(raw("/dsh same"))
        backend.messages["Beta"].append(raw("/dsh same"))
        events = adapter.poll()
        self.assertEqual({event["conversation_id"] for event in events}, {"uia_g1", "uia_g2"})
        self.assertEqual(len({event["message_id"] for event in events}), 2)


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

    def test_opt_in_minimises_without_activating(self):
        fake_user32 = mock.MagicMock()
        backend = self.backend()
        env = {"DSH_WECHAT_GROUP_AUTO_MINIMIZE": "1"}
        with mock.patch.object(uia.os, "environ", env):
            with mock.patch.object(uia, "_user32", lambda: fake_user32):
                with mock.patch.object(uia, "_window_is_minimised", lambda hwnd: False):
                    backend.maybe_auto_minimize()
        names = [call[0] for call in fake_user32.mock_calls]
        self.assertEqual(names, ["ShowWindow"])
        # 7 = SW_SHOWMINNOACTIVE. Anything else could activate and steal focus.
        self.assertEqual(fake_user32.ShowWindow.call_args[0][1], 7)

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


class ClassifierFakeWin:
    def __init__(self, exists, class_name="", name=""):
        self._exists = exists
        self.ClassName = class_name
        self.Name = name

    def Exists(self, seconds, interval):
        return self._exists


class ClassifierFakeRoot:
    def __init__(self, children):
        self._children = children

    def GetChildren(self):
        return self._children


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

    def GetRootControl(self):
        children = []
        if self._shell:
            children.append(ClassifierFakeWin(True, "Qt51514QWindowIcon", "微信"))
        return ClassifierFakeRoot(children)


class PanelClosedClassifierTests(unittest.TestCase):
    """classify_missing_main_window separates signed-out, closed-panel, absent."""

    def test_login_screen_wins_over_shell(self):
        # With both a login window and a leftover shell, the actionable truth is
        # the login prompt, so wechat_logged_out must be checked first.
        fake = ClassifierFakeAuto(main=False, login=True, shell=True)
        self.assertEqual(uia.classify_missing_main_window(fake), "wechat_logged_out")

    def test_shell_without_mmui_tree_is_panel_closed(self):
        fake = ClassifierFakeAuto(main=False, login=False, shell=True)
        self.assertEqual(uia.classify_missing_main_window(fake), "wechat_panel_closed")

    def test_nothing_running_is_main_window_missing(self):
        fake = ClassifierFakeAuto(main=False, login=False, shell=False)
        self.assertEqual(uia.classify_missing_main_window(fake), "main_window_missing")

    def test_panel_closed_message_names_the_headless_fix(self):
        # Tell the operator to minimise (which keeps the bridge alive), not just
        # that something is missing.
        self.assertIn("minimise", uia.ERROR_MESSAGES["wechat_panel_closed"].lower())

    def test_missing_window_message_says_start_wechat(self):
        self.assertIn("start", uia.ERROR_MESSAGES["main_window_missing"].lower())


if __name__ == "__main__":
    unittest.main()

