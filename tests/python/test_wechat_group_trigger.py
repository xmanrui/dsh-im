import unittest
from scripts import wechat_group_uia as uia

class TriggerPolicyTests(unittest.TestCase):
    def _row(self, text):
        return {"cls": "mmui::ChatTextItemView", "name": text}

    def test_default_group_cannot_trigger_on_unverified_row(self):
        g = uia.GroupConfig(id="uia_g1", title="Alpha")
        msgs = uia.read_visible_rows_as_messages([self._row("/dsh hello")], allow_unverified=True)
        ev = uia.build_message_event(g.id, g.title, msgs[0], trigger=g.command_prefix,
                                    sent_at=1, allow_unverified_trigger=False)
        self.assertFalse(ev["addressed"])

    def test_opted_in_group_can_trigger_but_keeps_identity_unverified(self):
        g = uia.GroupConfig(id="uia_g1", title="Alpha", allow_unverified_trigger=True)
        msgs = uia.read_visible_rows_as_messages([self._row("/dsh hello")], allow_unverified=True)
        ev = uia.build_message_event(g.id, g.title, msgs[0], trigger=g.command_prefix,
                                    sent_at=1, allow_unverified_trigger=True)
        self.assertTrue(ev["addressed"])
        self.assertTrue(uia.unverified_sender(ev["from_user_id"]))
        self.assertEqual(ev["text"], "hello")

    def test_opt_in_does_not_grant_identity_verification(self):
        sender = "uia-unverified:row"
        self.assertTrue(uia.unverified_sender(sender))

if __name__ == "__main__":
    unittest.main()
