"""Jarvis on the desktop wallpaper: the reactor, a clock, what Jarvis is doing and its last reply, drawn over the
user's own wallpaper.

Windows has no official interactive wallpapers. Two ways are supported:
  * "back" (the default): a full-screen window kept behind every other window. It works on Windows 11 24H2 and
    later, where Explorer no longer draws windows placed inside the desktop. "Show desktop" hides it, and it
    covers the desktop icons, so it's best with icons hidden.
  * "layer" (JARVIS_WALLPAPER_MODE=layer): inside the desktop between the wallpaper and the icons, as Wallpaper
    Engine does, for earlier Windows. Clicks there go to the icons, so a mouse hook watches for clicks on the reactor.
Click the reactor to talk; double-click it to open the full window.

    python -m Frontend.Wallpaper      shows it on its own, cycling through Jarvis's states, for testing
"""
import ctypes
import datetime
import os
import sys
import time
from ctypes import wintypes

from PyQt5.QtCore import QPoint, QRect, Qt, QTimer, pyqtSignal
from PyQt5.QtGui import QColor, QFont, QPainter, QPixmap, QRadialGradient
from PyQt5.QtWidgets import QApplication, QGraphicsDropShadowEffect, QLabel, QWidget

from Frontend.Gui import STATE_COLORS, STATE_LABELS, ArcReactor

user32 = ctypes.windll.user32
SPI_GETDESKWALLPAPER = 0x73
WM_LBUTTONDOWN = 0x0201
WH_MOUSE_LL = 14
DOUBLE_CLICK_SECONDS = 0.4

LRESULT = ctypes.c_ssize_t
HOOKPROC = ctypes.WINFUNCTYPE(LRESULT, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM)
user32.CallNextHookEx.argtypes = [wintypes.HHOOK, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM]
user32.CallNextHookEx.restype = LRESULT
user32.SetWindowsHookExW.argtypes = [ctypes.c_int, HOOKPROC, wintypes.HINSTANCE, wintypes.DWORD]
user32.SetWindowsHookExW.restype = wintypes.HHOOK
user32.WindowFromPoint.argtypes = [wintypes.POINT]
user32.WindowFromPoint.restype = wintypes.HWND
user32.GetAncestor.restype = wintypes.HWND
user32.FindWindowW.restype = wintypes.HWND
user32.FindWindowExW.restype = wintypes.HWND
user32.SetParent.restype = wintypes.HWND
user32.SetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_long]
user32.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]
user32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_uint]


class MouseHookData(ctypes.Structure):
    _fields_ = [("pt", wintypes.POINT), ("mouseData", wintypes.DWORD), ("flags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.c_size_t)]


class WindowPos(ctypes.Structure):
    _fields_ = [("hwnd", wintypes.HWND), ("hwndInsertAfter", wintypes.HWND), ("x", ctypes.c_int), ("y", ctypes.c_int),
                ("cx", ctypes.c_int), ("cy", ctypes.c_int), ("flags", ctypes.c_uint)]


def class_name(hwnd):
    buffer = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, buffer, 256)
    return buffer.value


def wallpaper_path():
    buffer = ctypes.create_unicode_buffer(520)
    user32.SystemParametersInfoW(SPI_GETDESKWALLPAPER, 520, buffer, 0)
    return buffer.value if buffer.value and os.path.exists(buffer.value) else None


def desktop_layer():
    """The window between the wallpaper and the desktop icons, or None if Explorer won't make one."""
    progman = user32.FindWindowW("Progman", None)
    if not progman:
        return None
    user32.SendMessageTimeoutW(progman, 0x052C, 0xD, 0x1, 0, 1000, None)
    # Windows 11 24H2 and later: the layer is a child of Progman.
    layer = user32.FindWindowExW(progman, None, "WorkerW", None)
    if layer:
        return layer
    # Earlier: it's the WorkerW after the one holding the icons.
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def each(hwnd, _):
        if user32.FindWindowExW(hwnd, None, "SHELLDLL_DefView", None):
            found.append(user32.FindWindowExW(None, hwnd, "WorkerW", None))
        return True

    user32.EnumWindows(each, 0)
    return next((w for w in found if w), None)


def is_desktop(hwnd):
    """Whether this window (the one under the mouse) is the desktop itself, not an app in front of it."""
    root = user32.GetAncestor(hwnd, 2)  # GA_ROOT
    return class_name(root) in ("Progman", "WorkerW")


class WallpaperWindow(QWidget):
    listen_requested = pyqtSignal()
    open_requested = pyqtSignal()
    sleep_toggled = pyqtSignal()
    quit_requested = pyqtSignal()

    REACTOR_SIZE = 380

    def __init__(self):
        super().__init__(None, Qt.FramelessWindowHint | Qt.Tool)
        self.setAttribute(Qt.WA_ShowWithoutActivating)
        screen = QApplication.primaryScreen()
        self.setGeometry(screen.geometry())
        self.background = self._load_background()
        self.state = "booting"
        self.hovering = False
        self.asleep = False
        self.last_click = 0.0

        self.reactor = ArcReactor(self)
        self.reactor.setMinimumSize(self.REACTOR_SIZE, self.REACTOR_SIZE)
        size = self.REACTOR_SIZE
        # The middle of the screen, inside the rings drawn on the Jarvis wallpaper (Frontend/WallpaperArt.py).
        from Frontend.WallpaperArt import HUD_CENTRE
        self.reactor.setGeometry(int(self.width() * HUD_CENTRE[0] - size / 2), int(self.height() * HUD_CENTRE[1] - size / 2), size, size)
        scale = self.height() / 1080
        rings_top = self.reactor.geometry().center().y() - int(340 * scale)
        rings_bottom = self.reactor.geometry().center().y() + int(340 * scale)
        self.reactor.setAttribute(Qt.WA_TransparentForMouseEvents)

        def label(point_size, weight=QFont.Normal, colour="#e8f6ff"):
            text = QLabel(self)
            # Sizes go in the style sheet: the app's own style sheet would otherwise override them.
            text.base_style = f"font-family: 'Segoe UI'; font-size: {point_size}pt; font-weight: {int(weight * 8)}; background: transparent;"
            text.setStyleSheet(f"color: {colour}; {text.base_style}")
            text.setAlignment(Qt.AlignHCenter | Qt.AlignTop)
            text.setWordWrap(True)
            shadow = QGraphicsDropShadowEffect(text)  # readable on any wallpaper, light or dark
            shadow.setBlurRadius(14)
            shadow.setOffset(0, 1)
            shadow.setColor(QColor(0, 0, 0, 230))
            text.setGraphicsEffect(shadow)
            return text

        centre_x = self.reactor.geometry().center().x()
        self.clock = label(34, QFont.Light)
        self.clock.setGeometry(centre_x - 300, rings_top - 122, 600, 60)
        self.date = label(11, colour="#9fd8ff")
        self.date.setGeometry(centre_x - 300, rings_top - 62, 600, 26)
        self.state_text = label(12, QFont.DemiBold)
        self.state_text.setGeometry(centre_x - 300, rings_bottom + 6, 600, 26)
        self.status = label(10, colour="#bfe6ff")
        self.status.setGeometry(centre_x - 300, rings_bottom + 32, 600, 24)
        self.reply = label(10, colour="#d8eefc")
        self.reply.setGeometry(centre_x - 300, rings_bottom + 58, 600, 44)

        self._tick_clock()
        QTimer(self, timeout=self._tick_clock, interval=1000).start()
        QTimer(self, timeout=self._follow_mouse, interval=60).start()
        self.wallpaper_file = wallpaper_path()
        QTimer(self, timeout=self._check_wallpaper, interval=60_000).start()
        self.set_state("booting")
        self.hook = None

    def _load_background(self):
        path = wallpaper_path()
        picture = QPixmap(path) if path else QPixmap()
        if picture.isNull():
            return None
        return picture.scaled(self.size(), Qt.KeepAspectRatioByExpanding, Qt.SmoothTransformation)

    def _check_wallpaper(self):
        """Picks up a new wallpaper if the user changes it."""
        path = wallpaper_path()
        if path != self.wallpaper_file:
            self.wallpaper_file = path
            self.background = self._load_background()
            self.update()

    # ── what Jarvis is doing
    def set_state(self, state):
        self.state = state
        self.reactor.set_state(state)
        colour = STATE_COLORS.get(state, STATE_COLORS["idle"]).name()
        self.state_text.setText(STATE_LABELS.get(state, state.upper()))
        self.state_text.setStyleSheet(f"color: {colour}; {self.state_text.base_style}")

    def set_status(self, text):
        self.status.setText(text)

    def set_reply(self, role, text):
        if role == "jarvis":
            self.reply.setText(text if len(text) <= 150 else text[:147].rsplit(" ", 1)[0] + "…")

    def _tick_clock(self):
        now = datetime.datetime.now()
        self.clock.setText(now.strftime("%H:%M"))
        self.date.setText(now.strftime("%A, %d %B").upper())

    # ── the mouse: glow when it's near, and clicks on the reactor
    def _reactor_on_screen(self):
        """The reactor's circle in physical screen pixels, which is what the mouse hook reports."""
        ratio = self.devicePixelRatioF()
        rect = self.reactor.geometry()
        centre = self.mapToGlobal(rect.center())
        return centre.x() * ratio, centre.y() * ratio, rect.width() / 2 * ratio

    def _follow_mouse(self):
        point = wintypes.POINT()
        user32.GetCursorPos(ctypes.byref(point))
        x, y, radius = self._reactor_on_screen()
        under = user32.WindowFromPoint(point)
        visible_there = under == int(self.winId()) if getattr(self, "mode", "") != "layer" else is_desktop(under)
        near = (point.x - x) ** 2 + (point.y - y) ** 2 <= (radius * 1.15) ** 2 and visible_there
        if near != self.hovering:
            self.hovering = near
            self.update()

    def _on_click(self, x, y):
        cx, cy, radius = self._reactor_on_screen()
        if (x - cx) ** 2 + (y - cy) ** 2 > (radius * 0.8) ** 2:
            return
        if not is_desktop(user32.WindowFromPoint(wintypes.POINT(x, y))):
            return  # an app window is in front of the wallpaper there
        now = time.time()
        if now - self.last_click < DOUBLE_CLICK_SECONDS:
            self.last_click = 0.0
            QTimer.singleShot(0, self.open_requested.emit)
        else:
            self.last_click = now
            QTimer.singleShot(0, self.listen_requested.emit)

    def closeEvent(self, event):
        if self.hook:
            user32.UnhookWindowsHookEx(self.hook)
            self.hook = None
        super().closeEvent(event)

    def install_mouse_hook(self):
        def hook(code, message, data):
            if code == 0 and message == WM_LBUTTONDOWN:
                point = ctypes.cast(data, ctypes.POINTER(MouseHookData)).contents.pt
                try:
                    self._on_click(point.x, point.y)
                except Exception as e:
                    print(f"Wallpaper click failed: {e}")
            return user32.CallNextHookEx(None, code, message, data)  # every click still reaches the desktop

        self._hook_proc = HOOKPROC(hook)  # kept, or Windows would call freed memory
        self.hook = user32.SetWindowsHookExW(WH_MOUSE_LL, self._hook_proc, None, 0)
        if not self.hook:
            print("Wallpaper: couldn't watch the mouse, so clicking the reactor won't work")

    # ── drawing
    def paintEvent(self, event):
        painter = QPainter(self)
        if self.background:
            painter.drawPixmap(event.rect(), self.background, event.rect())
        else:
            painter.fillRect(event.rect(), QColor("#060b14"))
        # A soft shade behind the HUD, so it stands out on a bright wallpaper.
        centre = self.reactor.geometry().center() + QPoint(0, 40)
        shade = QRadialGradient(centre, self.REACTOR_SIZE * 1.15)
        shade.setColorAt(0, QColor(2, 8, 18, 150))
        shade.setColorAt(0.65, QColor(2, 8, 18, 90))
        shade.setColorAt(1, QColor(2, 8, 18, 0))
        painter.setPen(Qt.NoPen)
        painter.setBrush(shade)
        r = int(self.REACTOR_SIZE * 1.15)
        painter.drawEllipse(QRect(centre - QPoint(r, r), centre + QPoint(r, r)))
        if self.hovering:
            centre = self.reactor.geometry().center()
            glow = QRadialGradient(centre, self.REACTOR_SIZE * 0.62)
            colour = QColor(STATE_COLORS.get(self.state, STATE_COLORS["idle"]))
            colour.setAlpha(70)
            glow.setColorAt(0, colour)
            glow.setColorAt(1, QColor(0, 0, 0, 0))
            painter.setPen(Qt.NoPen)
            painter.setBrush(glow)
            r = int(self.REACTOR_SIZE * 0.62)
            painter.drawEllipse(QRect(centre - QPoint(r, r), centre + QPoint(r, r)))

    # ── putting it on the desktop
    def attach(self):
        """Shows it as part of the wallpaper. Returns False if Windows didn't allow it."""
        self.mode = os.getenv("JARVIS_WALLPAPER_MODE", "back").lower()
        if self.mode != "layer":
            hwnd = int(self.winId())
            ex_style = user32.GetWindowLongW(hwnd, -20)  # GWL_EXSTYLE
            user32.SetWindowLongW(hwnd, -20, ctypes.c_long((ex_style | 0x08000000) & 0xFFFFFFFF).value)  # WS_EX_NOACTIVATE
            self.show()
            user32.SetWindowPos(hwnd, wintypes.HWND(1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010)  # HWND_BOTTOM
            return True
        self.show()
        layer = desktop_layer()
        if not layer:
            print("Wallpaper: Explorer didn't provide the desktop layer")
            self.hide()
            return False
        hwnd = int(self.winId())
        user32.SetParent(hwnd, layer)
        # The layer covers every screen, starting at the top-left of them all; the primary screen may not be first.
        ratio = self.devicePixelRatioF()
        left, top = user32.GetSystemMetrics(76), user32.GetSystemMetrics(77)  # SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN
        width, height = int(self.width() * ratio), int(self.height() * ratio)
        user32.SetWindowPos(hwnd, None, -left, -top, width, height, 0x0004 | 0x0010 | 0x0040)  # no z-order, no activate, show
        self.install_mouse_hook()
        return True

    def nativeEvent(self, event_type, message):
        """Keeps it behind every other window, even when it's clicked."""
        if getattr(self, "mode", "") != "layer":
            msg = wintypes.MSG.from_address(int(message))
            if msg.message == 0x0046:  # WM_WINDOWPOSCHANGING
                position = ctypes.cast(msg.lParam, ctypes.POINTER(WindowPos)).contents
                position.hwndInsertAfter = 1  # HWND_BOTTOM
                position.flags &= ~0x0004     # make sure the z-order is applied (not SWP_NOZORDER)
        return False, 0

    def _in_reactor(self, point, margin=0.8):
        centre = self.reactor.geometry().center()
        radius = self.reactor.width() / 2 * margin
        return (point.x() - centre.x()) ** 2 + (point.y() - centre.y()) ** 2 <= radius ** 2

    def mousePressEvent(self, event):
        if event.button() == Qt.LeftButton and self._in_reactor(event.pos()):
            self.listen_requested.emit()

    def contextMenuEvent(self, event):
        """Right-clicking the reactor: everything the app's window and tray icon used to do."""
        if not self._in_reactor(event.pos(), margin=1.0):
            return
        from PyQt5.QtWidgets import QMenu
        menu = QMenu()
        menu.addAction("Talk", self.listen_requested.emit)
        menu.addAction("Type a message", self.open_requested.emit)
        menu.addAction("Wake up" if self.asleep else "Go to sleep", self.sleep_toggled.emit)
        menu.addSeparator()
        menu.addAction("Quit Jarvis", self.quit_requested.emit)
        menu.exec_(event.globalPos())

    def mouseDoubleClickEvent(self, event):
        if event.button() == Qt.LeftButton and self._in_reactor(event.pos()):
            self.open_requested.emit()


def demo():
    """Shows it for a few seconds, cycling through Jarvis's states, and saves a picture of it."""
    app = QApplication(sys.argv)
    from Frontend.Gui import STYLE
    app.setStyleSheet(STYLE)  # as in the app, so the demo looks the same
    window = WallpaperWindow()
    attached = window.attach()
    user32.GetAncestor.argtypes = [wintypes.HWND, ctypes.c_uint]
    parent = user32.GetAncestor(int(window.winId()), 1)  # GA_PARENT
    grandparent = user32.GetAncestor(parent, 1) if parent else None
    rect = wintypes.RECT()
    user32.GetWindowRect(int(window.winId()), ctypes.byref(rect))
    print("attached:", attached, "| parent:", class_name(parent), "| its parent:", class_name(grandparent),
          "| on screen at", (rect.left, rect.top, rect.right, rect.bottom), "| visible:", bool(user32.IsWindowVisible(int(window.winId()))),
          "| mouse hook:", bool(window.hook))
    states = iter(["idle", "listening", "thinking", "speaking", "idle"])
    window.set_status("Say \"Hey Jarvis\", or click the reactor")
    window.set_reply("jarvis", "Good evening, sir. All systems are online.")

    def next_state():
        state = next(states, None)
        if state is None:
            window.grab().save(sys.argv[2] if len(sys.argv) > 2 and not sys.argv[2].startswith("--") else "wallpaper_demo.png")
            app.quit()
        else:
            window.set_state(state)

    QTimer(window, timeout=next_state, interval=1200).start()
    window.listen_requested.connect(lambda: print("CLICKED: listen"))
    window.open_requested.connect(lambda: print("CLICKED: open"))
    if "--click" in sys.argv:
        from PyQt5.QtTest import QTest
        centre = window.reactor.geometry().center()
        QTimer.singleShot(500, lambda: QTest.mouseClick(window, Qt.LeftButton, pos=centre))
        QTimer.singleShot(900, lambda: QTest.mouseDClick(window, Qt.LeftButton, pos=centre))
        QTimer.singleShot(1300, lambda: QTest.mouseClick(window, Qt.LeftButton, pos=centre + QPoint(600, 0)))
    app.exec_()


if __name__ == "__main__":
    demo()
