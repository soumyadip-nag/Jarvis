"""Starts Jarvis as a normal Windows app, with no terminal. The desktop icon opens this (see install_jarvis.ps1).

There's no terminal to show messages, so they go to Data/jarvis.log.
"""
import ctypes
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
os.chdir(ROOT)
sys.path.insert(0, str(ROOT))

ALREADY_EXISTS = 183
SW_RESTORE = 9


def main():
    # Only one copy: two would both pick up a call request and ring the person twice.
    # The handle stays open until the app exits, and Windows then frees it.
    mutex = ctypes.windll.kernel32.CreateMutexW(None, False, "JarvisDesktopApp")
    if ctypes.windll.kernel32.GetLastError() == ALREADY_EXISTS:
        window = ctypes.windll.user32.FindWindowW(None, "Jarvis")
        if window:
            ctypes.windll.user32.ShowWindow(window, SW_RESTORE)
            ctypes.windll.user32.SetForegroundWindow(window)
        return

    log = open(ROOT / "Data" / "jarvis.log", "w", encoding="utf-8", buffering=1)
    sys.stdout = sys.stderr = log

    # Gives Jarvis its own icon on the taskbar, instead of Python's.
    ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("Ushnish.Jarvis")

    from Frontend.Gui import GraphicalUserInterface
    GraphicalUserInterface()
    del mutex


if __name__ == "__main__":
    main()
