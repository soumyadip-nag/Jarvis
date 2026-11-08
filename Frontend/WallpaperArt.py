"""Draws the Jarvis desktop wallpaper, sized to the screen, with room in the middle for the live reactor.

    python -m Frontend.WallpaperArt            draws it to Data/jarvis_wallpaper.png and sets it as the wallpaper
    python -m Frontend.WallpaperArt --preview  only draws it

The previous wallpaper is copied to Data/previous_wallpaper first, so it can be put back.
"""
import ctypes
import math
import random
import shutil
import sys
from pathlib import Path

from PyQt5.QtCore import QPointF, QRectF, Qt
from PyQt5.QtGui import QColor, QFont, QImage, QLinearGradient, QPainter, QPainterPath, QPen, QRadialGradient
from PyQt5.QtWidgets import QApplication

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "Data" / "jarvis_wallpaper.png"
HUD_CENTRE = (0.5, 0.46)   # where the live reactor sits (Frontend/Wallpaper.py uses the same point)
CYAN = QColor(52, 198, 255)
ICE = QColor(170, 230, 255)
AMBER = QColor(255, 176, 64)

READOUTS_LEFT = [
    "SYS.CORE ............ ONLINE",
    "NEURAL LINK ......... STABLE",
    "VOICE MATRIX ........ RYAN-GB",
    "MEMORY SYNC ......... PHONE / LAPTOP",
    "WAKE PHRASE ......... HEY JARVIS",
    "UPLINK .............. SECURE",
]
READOUTS_RIGHT = [
    "LOCATION  SERAMPORE",
    "22.75°N  88.34°E",
    "GRID  IST  UTC+05:30",
    "OPERATOR  USHNISH CHOWDHURY",
    "PROTOCOL  STANDBY",
    "ARMOUR  N/A",
]


def screen_size():
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        pass
    user32 = ctypes.windll.user32
    return user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)


def colour(base, alpha):
    c = QColor(base)
    c.setAlpha(max(0, min(255, int(alpha))))
    return c


def draw(width, height, seed=7):
    random.seed(seed)
    image = QImage(width, height, QImage.Format_RGB32)
    p = QPainter(image)
    p.setRenderHint(QPainter.Antialiasing)
    s = height / 1080                      # everything is designed at 1080 high, then scaled
    cx, cy = width * HUD_CENTRE[0], height * HUD_CENTRE[1]
    centre = QPointF(cx, cy)

    # Deep space: a navy glow at the centre, falling to near black.
    glow = QRadialGradient(centre, max(width, height) * 0.75)
    glow.setColorAt(0, QColor(13, 34, 60))
    glow.setColorAt(0.45, QColor(6, 16, 32))
    glow.setColorAt(1, QColor(1, 4, 10))
    p.fillRect(0, 0, width, height, glow)

    # A faint hex grid, strongest near the centre.
    r = 34 * s
    w_hex, h_hex = math.sqrt(3) * r, 1.5 * r
    row = 0
    y = -r
    while y < height + r:
        x = -w_hex + (w_hex / 2 if row % 2 else 0)
        while x < width + w_hex:
            distance = math.hypot(x - cx, y - cy) / max(width, height)
            alpha = 26 * max(0.0, 1 - distance * 1.6)
            if alpha > 1:
                hexagon = QPainterPath()
                for k in range(7):
                    a = math.radians(60 * k + 30)
                    point = QPointF(x + r * 0.92 * math.cos(a), y + r * 0.92 * math.sin(a))
                    hexagon.moveTo(point) if k == 0 else hexagon.lineTo(point)
                p.setPen(QPen(colour(CYAN, alpha), 1))
                p.drawPath(hexagon)
            x += w_hex
        y += h_hex
        row += 1

    # Circuit traces running out from the rings to the edges, with right-angle bends and nodes.
    for _ in range(26):
        angle = random.uniform(0, 2 * math.pi)
        start = QPointF(cx + math.cos(angle) * 330 * s, cy + math.sin(angle) * 330 * s)
        path = QPainterPath(start)
        point = QPointF(start)
        horizontal = abs(math.cos(angle)) > 0.5
        for _ in range(random.randint(2, 4)):
            step = random.uniform(80, 260) * s
            if horizontal:
                point = QPointF(point.x() + math.copysign(step, math.cos(angle)), point.y())
            else:
                point = QPointF(point.x(), point.y() + math.copysign(step, math.sin(angle)))
            path.lineTo(point)
            horizontal = not horizontal
        fade = random.uniform(30, 70)
        p.setPen(QPen(colour(CYAN, fade), 1.2 * s))
        p.setBrush(Qt.NoBrush)
        p.drawPath(path)
        p.setPen(Qt.NoPen)
        p.setBrush(colour(ICE, fade * 2.2))
        p.drawEllipse(point, 2.6 * s, 2.6 * s)

    # The rings around the reactor's place: segmented arcs, ticks and one amber accent.
    def arc(radius, start_deg, span_deg, width_px, c, alpha):
        p.setPen(QPen(colour(c, alpha), width_px * s, Qt.SolidLine, Qt.FlatCap))
        p.setBrush(Qt.NoBrush)
        rect = QRectF(cx - radius * s, cy - radius * s, 2 * radius * s, 2 * radius * s)
        p.drawArc(rect, int(start_deg * 16), int(span_deg * 16))

    for k in range(24):  # a broken ring
        if k % 5:
            arc(250, k * 15 + 2, 11, 3, CYAN, 120)
    arc(268, 0, 360, 1, CYAN, 70)
    arc(300, 20, 140, 6, CYAN, 90)
    arc(300, 200, 140, 6, CYAN, 90)
    arc(300, 165, 30, 6, AMBER, 170)
    for k in range(120):  # tick marks
        a = math.radians(k * 3)
        inner = 322 if k % 10 else 312
        p.setPen(QPen(colour(ICE, 150 if k % 10 == 0 else 60), (2 if k % 10 == 0 else 1) * s))
        p.drawLine(QPointF(cx + math.cos(a) * inner * s, cy + math.sin(a) * inner * s),
                   QPointF(cx + math.cos(a) * 334 * s, cy + math.sin(a) * 334 * s))
    arc(370, 100, 70, 2, CYAN, 80)
    arc(370, 280, 70, 2, CYAN, 80)
    arc(420, 30, 40, 1.5, ICE, 60)
    arc(420, 210, 40, 1.5, ICE, 60)
    arc(470, 0, 360, 1, CYAN, 25)

    # Glowing dust.
    readouts = [QRectF(60 * s, cy - 140 * s, 520 * s, 230 * s), QRectF(width - 580 * s, cy - 140 * s, 520 * s, 230 * s),
                 QRectF(cx - 420 * s, height - 140 * s, 840 * s, 80 * s)]
    for _ in range(260):
        x, y = random.uniform(0, width), random.uniform(0, height)
        if any(area.contains(QPointF(x, y)) for area in readouts):
            continue  # keep the text clean
        size = random.choice([0.8, 1.0, 1.2, 1.6, 2.4]) * s
        dot = QRadialGradient(QPointF(x, y), size * 3)
        dot.setColorAt(0, colour(ICE, random.uniform(60, 200)))
        dot.setColorAt(1, colour(ICE, 0))
        p.setPen(Qt.NoPen)
        p.setBrush(dot)
        p.drawEllipse(QPointF(x, y), size * 3, size * 3)

    # Readouts at the sides.
    mono = QFont("Consolas", int(11 * s))
    mono.setLetterSpacing(QFont.AbsoluteSpacing, 1.2 * s)
    p.setFont(mono)
    left_x, right_x = 90 * s, width - 90 * s
    top = cy - 90 * s
    for i, line in enumerate(READOUTS_LEFT):
        p.setPen(colour(ICE, 150 if i % 2 == 0 else 110))
        p.drawText(QPointF(left_x, top + i * 30 * s), line)
    p.setPen(QPen(colour(CYAN, 120), 1.5 * s))
    p.drawLine(QPointF(left_x, top - 30 * s), QPointF(left_x + 280 * s, top - 30 * s))
    for i, line in enumerate(READOUTS_RIGHT):
        p.setPen(colour(ICE, 150 if i % 2 == 0 else 110))
        rect = QRectF(right_x - 420 * s, top + i * 30 * s - 18 * s, 420 * s, 26 * s)
        p.drawText(rect, Qt.AlignRight | Qt.AlignVCenter, line)
    p.setPen(QPen(colour(AMBER, 160), 1.5 * s))
    p.drawLine(QPointF(right_x - 280 * s, top - 30 * s), QPointF(right_x, top - 30 * s))

    # Corner brackets.
    p.setPen(QPen(colour(CYAN, 110), 2 * s))
    m, length = 40 * s, 70 * s
    for x, y, dx, dy in [(m, m, 1, 1), (width - m, m, -1, 1), (m, height - m, 1, -1), (width - m, height - m, -1, -1)]:
        p.drawLine(QPointF(x, y), QPointF(x + dx * length, y))
        p.drawLine(QPointF(x, y), QPointF(x, y + dy * length))

    # The name along the bottom.
    title = QFont("Segoe UI", int(13 * s), QFont.Light)
    title.setLetterSpacing(QFont.AbsoluteSpacing, 9 * s)
    p.setFont(title)
    p.setPen(colour(ICE, 170))
    p.drawText(QRectF(0, height - 120 * s, width, 30 * s), Qt.AlignCenter, "J . A . R . V . I . S .")
    small = QFont("Segoe UI", int(9 * s))
    small.setLetterSpacing(QFont.AbsoluteSpacing, 4 * s)
    p.setFont(small)
    p.setPen(colour(CYAN, 120))
    p.drawText(QRectF(0, height - 88 * s, width, 24 * s), Qt.AlignCenter, "JUST A RATHER VERY INTELLIGENT SYSTEM")
    line = QLinearGradient(QPointF(cx - 300 * s, 0), QPointF(cx + 300 * s, 0))
    line.setColorAt(0, colour(CYAN, 0))
    line.setColorAt(0.5, colour(CYAN, 160))
    line.setColorAt(1, colour(CYAN, 0))
    p.setPen(QPen(line, 1.2 * s))
    p.drawLine(QPointF(cx - 300 * s, height - 128 * s), QPointF(cx + 300 * s, height - 128 * s))

    # Darker edges, to keep the eye in the middle.
    vignette = QRadialGradient(centre, max(width, height) * 0.8)
    vignette.setColorAt(0.55, QColor(0, 0, 0, 0))
    vignette.setColorAt(1, QColor(0, 0, 0, 150))
    p.fillRect(0, 0, width, height, vignette)
    p.end()
    return image


def set_as_wallpaper(path):
    user32 = ctypes.windll.user32
    previous = ctypes.create_unicode_buffer(520)
    user32.SystemParametersInfoW(0x73, 520, previous, 0)  # SPI_GETDESKWALLPAPER
    if previous.value and Path(previous.value).exists() and Path(previous.value).resolve() != Path(path).resolve():
        backup = path.parent / ("previous_wallpaper" + Path(previous.value).suffix)
        shutil.copyfile(previous.value, backup)
        print(f"The old wallpaper is saved as {backup}")
    # SPI_SETDESKWALLPAPER, saved and announced to Windows
    if not user32.SystemParametersInfoW(0x14, 0, str(path), 0x01 | 0x02):
        raise OSError("Windows didn't accept the new wallpaper")


def main():
    app = QApplication.instance() or QApplication(sys.argv)
    width, height = screen_size()
    OUTPUT.parent.mkdir(exist_ok=True)
    draw(width, height).save(str(OUTPUT))
    print(f"Drew {width}x{height}: {OUTPUT}")
    if "--preview" not in sys.argv:
        set_as_wallpaper(OUTPUT)
        print("Set as the wallpaper")
    del app


if __name__ == "__main__":
    main()
