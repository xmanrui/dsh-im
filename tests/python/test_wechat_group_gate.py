import io, json, os, unittest
from unittest import mock
from scripts import wechat_group_uia as uia

class GateTests(unittest.TestCase):
    def setUp(self):
        class B:
            def list_session_titles(self): return ["Alpha"]
            def current_chat_title(self): return "Alpha"
            def select_chat(self, t): pass
            def read_input(self): return ""
            def set_input(self, t): pass
            def press_enter(self): raise AssertionError("must not send")
            def read_messages(self): return []
            def close(self): pass
        self.backend = B()
        self.adapter = uia.WechatGroupAdapter([uia.GroupConfig(id="uia_g1", title="Alpha")], self.backend)
        self.protocol = uia.JsonlProtocol(self.adapter)
        self.protocol.start()

    def test_send_is_refused_unless_enabled(self):
        os.environ.pop("DSH_WECHAT_GROUP_ALLOW_SEND", None)
        frames = self.protocol.handle_request({"type": "send_text", "request_id": "r", "chat_id": "uia_g1", "text": "hi"})
        self.assertEqual(frames[-1]["type"], "error")
        self.assertEqual(frames[-1]["error"]["code"], "send_disabled")

    def test_unverified_text_match_is_not_trusted_as_named_reply(self):
        rows = [{"cls": "mmui::ChatTextItemView", "name": "/dsh run"}]
        msgs = uia.read_visible_rows_as_messages(rows, allow_unverified=True)
        self.assertTrue(uia.unverified_sender(msgs[0].sender))
        ev = uia.build_message_event("uia_g1", "Alpha", msgs[0], trigger="/dsh", sent_at=1)
        self.assertFalse(ev["addressed"])

class _RecordingStream:
    """stdout double: keeps every frame the protocol writes."""

    def __init__(self):
        self.rows = []

    def write(self, text):
        self.rows.append(text)

    def flush(self):
        pass


class _DelayedEmptyStdin:
    """stdin double: blocks briefly so the poll worker runs, then ends."""

    def __iter__(self):
        import time as _time
        _time.sleep(0.4)
        return iter([])


class SurfaceLossBackend:
    """Healthy for the start baseline, then the surface disappears on poll."""

    def __init__(self, failure="safety", surface_state=None, ok_reads=1):
        self.failure = failure
        self._surface_state = surface_state
        self._ok_reads = ok_reads
        self.reads = 0

    def list_session_titles(self): return ["Alpha"]
    def current_chat_title(self): return "Alpha"
    def select_chat(self, title): pass
    def read_input(self): return ""
    def set_input(self, text): pass
    def press_enter(self): pass
    def close(self): pass

    def surface_state(self):
        return self._surface_state

    def read_messages(self):
        self.reads += 1
        if self.reads > self._ok_reads:
            if self.failure == "safety":
                raise uia.SafetyError("surface gone", "control_missing")
            raise ValueError("raw COM error")
        return []


class PollSurfaceLossTests(unittest.TestCase):
    """A lost UIA surface must be said once with its real code, not flattened.

    Measured live: after the operator closed the WeChat panel the adapter emitted
    poll_failed every 750ms (about 80 lines an hour) while the actionable cause
    was a window-level loss. The generic code hid the diagnosis and the flood
    made the bridge look flaky rather than stopped.
    """

    def protocol(self, backend, exit_impl=None):
        adapter = uia.WechatGroupAdapter([uia.GroupConfig(id="uia_g1", title="Alpha")], backend)
        adapter.start()
        return uia.JsonlProtocol(adapter, exit_impl=exit_impl)

    def test_safety_surface_loss_frame_carries_the_real_code(self):
        protocol = self.protocol(SurfaceLossBackend(failure="safety"))
        frames = protocol.poll_frames()
        self.assertEqual(frames[0]["error"]["code"], "control_missing")
        self.assertEqual(protocol.fatal_code, "control_missing")

    def test_raw_com_error_maps_through_the_backend_probe(self):
        # uiautomation raises plain COM errors once the window dies; the probe
        # converts that into the same actionable code.
        protocol = self.protocol(SurfaceLossBackend(
            failure="com", surface_state="wechat_panel_closed"))
        frames = protocol.poll_frames()
        self.assertEqual(frames[0]["error"]["code"], "wechat_panel_closed")
        self.assertEqual(protocol.fatal_code, "wechat_panel_closed")

    def test_a_glitch_with_a_live_surface_stays_poll_failed_and_does_not_stop(self):
        # A one-off failure while the surface is still there must never tear the
        # bridge down, or a single UIA flicker would restart the transport.
        protocol = self.protocol(SurfaceLossBackend(failure="com", surface_state=None))
        frames = protocol.poll_frames()
        self.assertEqual(frames[0]["error"]["code"], "poll_failed")
        self.assertIsNone(protocol.fatal_code)

    def test_poll_loop_writes_the_fatal_frame_once_then_exits_once(self):
        exits = []
        stream = _RecordingStream()
        protocol = self.protocol(
            SurfaceLossBackend(failure="safety"), exit_impl=lambda code: exits.append(code))
        protocol.serve(_DelayedEmptyStdin(), stream, poll_interval_ms=100)
        self.assertEqual(exits, [4])
        codes = []
        for line in stream.rows:
            stripped = line.strip()
            if stripped.startswith("{"):
                record = json.loads(stripped)
                if "error" in record:
                    codes.append(record["error"]["code"])
        # Exactly one terminal frame: the flood is what buried the diagnosis.
        self.assertEqual(codes, ["control_missing"])


if __name__ == "__main__":
    unittest.main()

