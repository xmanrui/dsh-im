"""The shipped flag helper must stay dependency-free and honest about state."""

import importlib.util
import sys
import unittest
from pathlib import Path
from unittest import mock


def load_helper():
    """Import scripts/enable_wechat_uia_flag.py by path (it is a CLI, not a module)."""

    root = Path(__file__).resolve().parents[2]
    path = root / "scripts" / "enable_wechat_uia_flag.py"
    spec = importlib.util.spec_from_file_location("enable_wechat_uia_flag", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeUser32:
    """Records SystemParametersInfoW calls and reports one fixed flag state."""

    def __init__(self):
        self.calls = []
        self.state = False

    def SystemParametersInfoW(self, action, ui_param, pv_param, win_ini):
        self.calls.append((action, ui_param, win_ini))
        if action == 0x0047:
            self.state = bool(ui_param)
        elif action == 0x0046:
            # A real GET writes the flag into the caller's BOOL by reference.
            pv_param._obj.value = 1 if self.state else 0
        return 1


class FlagHelperTests(unittest.TestCase):

    def setUp(self):
        self.helper = load_helper()

    def test_non_windows_host_is_refused_with_code_2(self):
        with mock.patch.object(self.helper.sys, "platform", "linux"):
            self.assertEqual(self.helper.main([]), 2)

    def test_set_persists_the_flag_and_reports_success(self):
        fake = FakeUser32()
        with mock.patch.object(self.helper.sys, "platform", "win32"):
            with mock.patch.object(self.helper, "user32", lambda: fake):
                rc = self.helper.main([])
        self.assertEqual(rc, 0)
        # UPDATEINIFILE is what survives a WeChat restart; SENDCHANGE only broadcasts.
        self.assertEqual(fake.calls[0][2], 0x01 | 0x02)
        self.assertTrue(fake.state)

    def test_check_mode_never_writes(self):
        fake = FakeUser32()
        with mock.patch.object(self.helper.sys, "platform", "win32"):
            with mock.patch.object(self.helper, "user32", lambda: fake):
                rc = self.helper.main(["--check"])
        self.assertEqual(rc, 0)
        # A read may issue GET; only a SET would change the machine state.
        self.assertEqual([call for call in fake.calls if call[0] == 0x0047], [])

    def test_disable_turns_the_flag_off(self):
        fake = FakeUser32()
        fake.state = True
        with mock.patch.object(self.helper.sys, "platform", "win32"):
            with mock.patch.object(self.helper, "user32", lambda: fake):
                rc = self.helper.main(["--disable"])
        self.assertEqual(rc, 0)
        self.assertFalse(fake.state)


if __name__ == "__main__":
    unittest.main()