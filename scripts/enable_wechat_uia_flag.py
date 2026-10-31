"""Enable the Windows screen-reader flag that WeChat 4.x needs at process start.

WeChat 4.x builds its ``mmui::*`` accessibility (UIA) control tree only when
``SPI_SETSCREENREADER`` is already set the moment the WeChat process starts.
Turning the flag on afterwards, broadcasting WM_SETTINGCHANGE, restarting only
the window or calling WM_GETOBJECT cannot retro-fit an already-running process;
the observed symptom is a main window whose only UIA child is an empty
``MMUIRenderSubWindowHW`` pane and no ``mmui::MainWindow`` at all.

So the required order is: run this script once, then (re)start WeChat. The flag
is persisted system-wide, which is why no screen reader has to stay installed;
and no accessibility software needs to be running for WeChat to honour it.

Usage (Windows, any Python 3.9+; no third-party dependency):

    python scripts/enable_wechat_uia_flag.py            # set, then verify
    python scripts/enable_wechat_uia_flag.py --check    # read only
    python scripts/enable_wechat_uia_flag.py --disable  # restore the default

Exit code 0 means the requested end state is in force; 1 means it is not, and 2
means this is not a Windows host.
"""

from __future__ import annotations

import argparse
import sys

SPI_GETSCREENREADER = 0x0046
SPI_SETSCREENREADER = 0x0047
SPIF_UPDATEINIFILE = 0x01
SPIF_SENDCHANGE = 0x02


def user32():
    """Resolve the Win32 user32 module. Kept separate so tests can inject a fake."""

    import ctypes

    return ctypes.windll.user32


def read_flag(user32) -> bool:
    """Return the current SPI_SETSCREENREADER state as a plain bool."""

    import ctypes
    from ctypes import wintypes

    value = wintypes.BOOL()
    user32.SystemParametersInfoW(SPI_GETSCREENREADER, 0, ctypes.byref(value), 0)
    return bool(value.value)


def write_flag(user32, enabled: bool) -> None:
    """Persist the flag. UPDATEINIFILE is what survives a WeChat restart."""

    user32.SystemParametersInfoW(
        SPI_SETSCREENREADER, 1 if enabled else 0, None,
        SPIF_UPDATEINIFILE | SPIF_SENDCHANGE,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--check", action="store_true", help="only report the current flag")
    group.add_argument("--disable", action="store_true", help="turn the flag back off")
    args = parser.parse_args(argv)

    if sys.platform != "win32":
        print("unsupported_platform: this helper only applies to Windows", file=sys.stderr)
        return 2

    api = user32()
    wanted = not args.disable
    if not args.check:
        write_flag(api, wanted)
    state = read_flag(api)
    print("SPI_SETSCREENREADER =", state)
    if args.check:
        return 0
    if state is not wanted:
        print("flag_set_failed: the requested state did not stick", file=sys.stderr)
        return 1
    print("next step: start (or restart) WeChat so its accessibility tree is built")
    return 0


if __name__ == "__main__":
    sys.exit(main())
