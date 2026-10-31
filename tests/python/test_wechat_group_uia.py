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


if __name__ == "__main__":
    unittest.main()
