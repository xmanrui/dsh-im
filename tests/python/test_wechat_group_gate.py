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

if __name__ == "__main__":
    unittest.main()
