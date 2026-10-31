import unittest
import sys
sys.path.insert(0, "scripts")
import wechat_group_uia as m

class FakeBackend:
    def __init__(self, title, rows, kind="room"):
        self.title = title; self.rows = rows; self.kind = kind; self.clicks = []
    def list_session_titles(self): return ["s女王文杰", self.title]
    def current_chat_title(self): return self.title
    def select_chat(self, t): self.clicks.append(t)
    def read_input(self): return ""
    def set_input(self, t): pass
    def press_enter(self): pass
    def close(self): pass
    def read_messages(self):
        return m.read_visible_rows_as_messages(self.rows, allow_unverified=True)

class ObservedModeTests(unittest.TestCase):
    def test_group_rows_without_sender_are_observer_only(self):
        rows = [{"cls": "mmui::ChatTextItemView", "name": "这也有人给零食"},
                {"cls": "mmui::ChatItemView", "name": "昨天 22:55"},
                {"cls": "mmui::ChatTextItemView", "name": "@[___] 你好"}]
        msgs = m.read_visible_rows_as_messages(rows, allow_unverified=True)
        self.assertEqual(len(msgs), 2)
        sender = msgs[0].sender
        self.assertTrue(sender.startswith("uia-unverified:"), sender)
        self.assertFalse(msgs[0].is_self)
        self.assertTrue(all(x.message_type == 1 for x in msgs))
        self.assertTrue(m.unverified_sender(sender))

    def test_unverified_sender_cannot_grant_commands(self) -> None:
        msgs = m.read_visible_rows_as_messages(
            [{"cls": "mmui::ChatTextItemView", "name": "/dsh 执行"}], allow_unverified=True)
        ev = m.build_message_event("g1", "群A", msgs[0], trigger="/dsh", sent_at=1)
        self.assertFalse(ev["addressed"])

if __name__ == "__main__":
    unittest.main()
