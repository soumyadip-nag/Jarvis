"""J.A.R.V.I.S. desktop interface (PyQt5).

Everything is drawn in code, so no image assets are needed.

Layout
  ┌ title bar ─────────────────────────────────────────────┐
  │ arc reactor (animated by state) │  comms log (chat)     │
  │ status + system stats            │                       │
  │ quick actions                    │  [ input ] (mic)(send)│
  └────────────────────────────────────────────────────────┘

The backend runs on a worker QThread and talks to the UI only through Qt signals.
"""
import datetime
import math
import os
import random
import re
import sys
import threading
import time

from PyQt5.QtCore import Qt, QTimer, QThread, QObject, QLineF, QPointF, QRectF, pyqtSignal, pyqtSlot
from PyQt5.QtGui import (
    QColor, QFont, QIcon, QPainter, QPen, QPixmap, QRadialGradient, QLinearGradient, QBrush,
    QKeySequence, QFontMetrics, QConicalGradient, QPainterPath, QPolygonF,
)
from PyQt5.QtWidgets import (
    QApplication, QMainWindow, QWidget, QLabel, QLineEdit, QPushButton, QHBoxLayout, QVBoxLayout,
    QScrollArea, QFrame, QSizePolicy, QShortcut, QGraphicsDropShadowEffect, QGridLayout,
)

try:
    import psutil
except Exception:  # optional
    psutil = None

# ───────────────────────────── theme ─────────────────────────────
STATE_COLORS = {
    "booting":   QColor(90, 140, 170),
    "idle":      QColor(41, 208, 255),
    "listening": QColor(64, 255, 200),
    "thinking":  QColor(255, 176, 46),
    "speaking":  QColor(80, 180, 255),
    "offline":   QColor(255, 72, 72),
}
STATE_LABELS = {
    "booting": "INITIALISING",
    "idle": "STANDING BY",
    "listening": "LISTENING",
    "thinking": "PROCESSING",
    "speaking": "RESPONDING",
    "offline": "OFFLINE",
}
ACCENT = "#29d0ff"
TEXT = "#d8f3ff"
MUTED = "#6f8fa3"
FONT = "Segoe UI"
MONO = "Consolas"

STYLE = f"""
QWidget {{ color: {TEXT}; font-family: "{FONT}"; font-size: 13px; }}
QLabel#Title {{ font-size: 18px; font-weight: 600; letter-spacing: 6px; color: {ACCENT}; }}
QLabel#Subtitle {{ font-size: 10px; letter-spacing: 2px; color: {MUTED}; }}
QLabel#Clock {{ font-family: "{MONO}"; font-size: 13px; color: {ACCENT}; }}
QLabel#StateLabel {{ font-size: 15px; font-weight: 600; letter-spacing: 5px; }}
QLabel#StatusLabel {{ color: {MUTED}; font-size: 12px; }}
QLabel#SectionTitle {{ color: {MUTED}; font-size: 10px; font-weight: 600; letter-spacing: 3px; }}
QLabel#Footer {{ color: #47657a; font-size: 10px; letter-spacing: 1px; }}

QFrame#Panel {{
    background: rgba(10, 24, 38, 170);
    border: 1px solid rgba(41, 208, 255, 45);
    border-radius: 14px;
}}
QPushButton#WinBtn {{
    background: transparent; border: none; color: {MUTED}; font-size: 14px;
    min-width: 34px; min-height: 28px; border-radius: 6px;
}}
QPushButton#WinBtn:hover {{ background: rgba(41, 208, 255, 30); color: {TEXT}; }}
QPushButton#CloseBtn {{
    background: transparent; border: none; color: {MUTED}; font-size: 14px;
    min-width: 34px; min-height: 28px; border-radius: 6px;
}}
QPushButton#CloseBtn:hover {{ background: #c4314b; color: white; }}

QPushButton#Chip {{
    background: rgba(41, 208, 255, 18); border: 1px solid rgba(41, 208, 255, 60);
    border-radius: 13px; padding: 5px 12px; color: {TEXT}; font-size: 12px;
}}
QPushButton#Chip:hover {{ background: rgba(41, 208, 255, 45); border-color: {ACCENT}; }}
QPushButton#Chip:disabled {{ color: #3d5566; border-color: rgba(41, 208, 255, 25); }}

QPushButton#GhostBtn {{
    background: transparent; border: 1px solid rgba(41,208,255,50); border-radius: 8px;
    padding: 3px 10px; color: {MUTED}; font-size: 11px;
}}
QPushButton#GhostBtn:hover {{ color: {TEXT}; border-color: {ACCENT}; }}

QLineEdit#Input {{
    background: rgba(4, 12, 22, 220); border: 1px solid rgba(41, 208, 255, 70);
    border-radius: 22px; padding: 0 18px; font-size: 14px; color: {TEXT};
    selection-background-color: {ACCENT};
}}
QLineEdit#Input:focus {{ border: 1px solid {ACCENT}; }}

QPushButton#RoundBtn {{
    background: qlineargradient(x1:0, y1:0, x2:1, y2:1, stop:0 #1fb6ff, stop:1 #0a6ea8);
    border: none; border-radius: 22px; min-width: 44px; max-width: 44px; min-height: 44px; max-height: 44px;
    font-size: 17px; color: white;
}}
QPushButton#RoundBtn:hover {{ background: {ACCENT}; }}
QPushButton#RoundBtn:disabled {{ background: #1a3346; color: #4d6a7d; }}
QPushButton#RoundBtn[active="true"] {{ background: #19d9a3; }}

QScrollArea {{ background: transparent; border: none; }}
QScrollBar:vertical {{ background: transparent; width: 8px; margin: 4px 0; }}
QScrollBar::handle:vertical {{ background: rgba(41, 208, 255, 60); border-radius: 4px; min-height: 30px; }}
QScrollBar::handle:vertical:hover {{ background: rgba(41, 208, 255, 120); }}
QScrollBar::add-line, QScrollBar::sub-line {{ height: 0; }}
QScrollBar::add-page, QScrollBar::sub-page {{ background: transparent; }}
"""

QUICK_ACTIONS = [
    ("What's the news?", "What's today's top news?"),
    ("Tell me a joke", "Tell me a joke"),
    ("Open YouTube", "Open YouTube"),
    ("Volume up", "Volume up"),
    ("Time && date", "What's the time and date?"),
    ("Who are you?", "Who are you?"),
]


# ───────────────────────────── arc reactor ─────────────────────────────
class ArcReactor(QWidget):
    """Animated HUD reactor. Its colour and motion reflect what Jarvis is doing.

    The same design is drawn on the phone (cloud/public/reactor.js), so the two should change together.
    Layers, from the outside in: a radar sweep, framing arcs, a turning ring of text, ticks with markers,
    orbiting data points, a segmented ring with a running pulse, the voice spectrum, coils, a hex core and the core.
    """
    clicked = pyqtSignal()

    BARS = 96
    FPS = 30

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumSize(300, 300)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self.setCursor(Qt.PointingHandCursor)
        self.setToolTip("Click to talk  •  click again to stop")
        self.state = "booting"
        self.color = QColor(STATE_COLORS["booting"])
        self.t = 0.0
        self.level = 0.0         # smoothed "voice" energy
        self.bars = [0.0] * self.BARS
        self.ripples = []
        self._layers = {}        # parts that only rotate, drawn once and then turned: drawing them every frame is slow
        self._last = time.monotonic()
        self._timer = QTimer(self, timeout=self._tick)
        self._timer.start(int(1000 / self.FPS))

    def set_state(self, state):
        if state == "listening" and self.state != "listening":
            self.ripples = [0.0]
        self.state = state

    def mousePressEvent(self, event):
        if event.button() == Qt.LeftButton:
            self.clicked.emit()

    def advance(self, dt):
        """Moves the animation on by dt seconds."""
        self.t += dt
        ease = min(1.0, dt * 5)
        target = STATE_COLORS.get(self.state, STATE_COLORS["idle"])
        self.color = QColor(*(int(c + (g - c) * ease) for c, g in zip(self.color.getRgb()[:3], target.getRgb()[:3])))
        if self.state == "speaking":
            goal = 0.35 + 0.65 * abs(math.sin(self.t * 7.3) * math.sin(self.t * 2.1 + 1)) + random.uniform(-0.1, 0.1)
        elif self.state == "listening":
            goal = 0.25 + 0.15 * math.sin(self.t * 4)
        else:
            goal = 0.06 + 0.03 * math.sin(self.t * 1.7)  # a faint shimmer, so it never looks frozen
        self.level += (goal - self.level) * min(1.0, dt * 11)
        for i in range(self.BARS):
            wave = 0.5 + 0.5 * math.sin(i * 0.55 + self.t * 9) * math.sin(i * 0.21 - self.t * 5)
            goal_bar = self.level * (0.35 + 0.65 * wave) * random.uniform(0.75, 1.0)
            self.bars[i] += (goal_bar - self.bars[i]) * 0.35
        grow = 0.75 if self.state == "listening" else 1.25
        self.ripples = [p + dt * grow for p in self.ripples if p + dt * grow < 1.0]
        if self.state == "listening" and (not self.ripples or self.ripples[-1] > 0.33):
            self.ripples.append(0.0)

    def _tick(self):
        now = time.monotonic()
        self.advance(min(0.05, now - self._last))
        self._last = now
        if self.isVisible():
            self.update()

    def _c(self, alpha, lighter=100):
        c = QColor(self.color).lighter(lighter)
        c.setAlpha(max(0, min(255, int(alpha))))
        return c

    def _ring_of_text(self, R):
        """The turning ring of text, drawn once for each size, state and colour."""
        image, p, size = self._new_layer(R)
        font = QFont(MONO, max(5, int(R * 0.042)))
        font.setBold(True)
        p.setFont(font)
        p.setPen(self._c(150, 130))
        label = STATE_LABELS.get(self.state, self.state.upper())
        text = f"J.A.R.V.I.S  •  {label}  •  NEURAL CORE  •  SYNC PHONE/LAPTOP  •  "
        radius = R * 0.885
        # A whole number of repeats, so the text doesn't break where it meets itself.
        repeats = max(1, round(360 / math.degrees((R * 0.042 * 0.95) / radius) / len(text)))
        count = repeats * len(text)
        step = 360 / count
        p.translate(size / 2, size / 2)
        for i in range(count):
            p.save()
            p.rotate(i * step)
            p.drawText(QPointF(-R * 0.012, -radius), text[i % len(text)])
            p.restore()
        p.end()
        return image

    def _new_layer(self, R):
        size = int(R * 2) + 4
        image = QPixmap(size, size)
        image.fill(Qt.transparent)
        p = QPainter(image)
        p.setRenderHint(QPainter.Antialiasing)
        p.setRenderHint(QPainter.TextAntialiasing)
        return image, p, size

    def _layer(self, name, R, draw):
        """A layer drawn once for this size, state and colour (to the nearest shade)."""
        key = (int(R), self.state, tuple(v // 6 for v in self.color.getRgb()[:3]))
        if self._layers.get(name, (None,))[0] != key:
            self._layers[name] = (key, draw(R))
        return self._layers[name][1]

    def _ticks(self, R):
        image, p, size = self._new_layer(R)
        p.translate(size / 2, size / 2)
        for i in range(120):
            major = i % 10 == 0
            a = math.radians(i * 3)
            r1, r2 = R * 0.775, R * (0.82 if major else 0.80)
            p.setPen(QPen(self._c(190 if major else 70), 2 if major else 1))
            p.drawLine(QPointF(r1 * math.cos(a), r1 * math.sin(a)), QPointF(r2 * math.cos(a), r2 * math.sin(a)))
        p.setPen(Qt.NoPen)
        p.setBrush(self._c(210, 130))
        for k in range(4):
            a = math.radians(k * 90 + 45)
            tip, base, half = R * 0.755, R * 0.725, math.radians(2.2)
            p.drawPolygon(QPolygonF([
                QPointF(tip * math.cos(a), tip * math.sin(a)),
                QPointF(base * math.cos(a - half), base * math.sin(a - half)),
                QPointF(base * math.cos(a + half), base * math.sin(a + half)),
            ]))
        p.end()
        return image

    def _coils(self, R):
        image, p, size = self._new_layer(R)
        p.translate(size / 2, size / 2)
        coil = QPainterPath()
        inner, outer, half_in, half_out = R * 0.30, R * 0.40, math.radians(11), math.radians(13)
        coil.moveTo(inner * math.cos(-half_in), inner * math.sin(-half_in))
        coil.lineTo(outer * math.cos(-half_out), outer * math.sin(-half_out))
        coil.lineTo(outer * math.cos(half_out), outer * math.sin(half_out))
        coil.lineTo(inner * math.cos(half_in), inner * math.sin(half_in))
        coil.closeSubpath()
        for k in range(10):
            p.save()
            p.rotate(k * 36)
            p.setBrush(self._c(70))
            p.setPen(QPen(self._c(170), 1.2))
            p.drawPath(coil)
            p.restore()
        p.end()
        return image

    def _draw_layer(self, p, center, image, degrees, opacity=1.0):
        p.save()
        p.translate(center)
        p.rotate(degrees)
        p.setOpacity(min(1.0, opacity))
        p.drawPixmap(QPointF(-image.width() / 2, -image.height() / 2), image)
        p.restore()

    def paintEvent(self, event):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        w, h = self.width(), self.height()
        cx, cy = w / 2, h / 2
        R = min(w, h) / 2 - 6
        center = QPointF(cx, cy)
        t = self.t
        state = self.state
        speed = {"thinking": 3.0, "speaking": 1.5, "listening": 1.3}.get(state, 1.0)
        breathe = 0.5 + 0.5 * math.sin(t * (2.4 if state == "idle" else 4.0))

        def ring(radius):
            return QRectF(cx - radius, cy - radius, radius * 2, radius * 2)

        def arc(radius, start, span, width, colour, cap=Qt.FlatCap):
            p.setPen(QPen(colour, width, Qt.SolidLine, cap))
            p.setBrush(Qt.NoBrush)
            p.drawArc(ring(radius), int(-start * 16), int(-span * 16))  # clockwise from 3 o'clock, in degrees

        def polar(radius, degrees):
            a = math.radians(degrees)
            return QPointF(cx + radius * math.cos(a), cy + radius * math.sin(a))

        # Bloom.
        glow = QRadialGradient(center, R)
        glow.setColorAt(0.0, self._c(85 + 50 * self.level))
        glow.setColorAt(0.35, self._c(32))
        glow.setColorAt(1.0, self._c(0))
        p.setPen(Qt.NoPen)
        p.setBrush(QBrush(glow))
        p.drawEllipse(center, R, R)

        # Radar sweep across the outer band.
        sweep_angle = (t * 50 * speed) % 360
        sweep = QConicalGradient(center, -sweep_angle)
        sweep.setColorAt(0.0, self._c(95, 120))
        sweep.setColorAt(0.10, self._c(0))
        sweep.setColorAt(1.0, self._c(0))
        band = QPainterPath()
        band.addEllipse(center, R * 0.985, R * 0.985)
        band.addEllipse(center, R * 0.70, R * 0.70)
        band.setFillRule(Qt.OddEvenFill)
        p.setBrush(QBrush(sweep))
        p.drawPath(band)
        p.setPen(QPen(self._c(200, 140), 1.5))
        p.drawLine(polar(R * 0.70, sweep_angle), polar(R * 0.985, sweep_angle))

        # Hairlines and the framing arcs, with bracket ends.
        arc(R * 0.995, 0, 360, 1, self._c(45))
        arc(R * 0.83, 0, 360, 1, self._c(40))
        frame = t * 6 * speed
        for k in range(4):
            start = frame + k * 90 + 8
            arc(R * 0.965, start, 58, max(2.0, R * 0.018), self._c(190))
            for edge in (start, start + 58):
                p.setPen(QPen(self._c(220, 130), 1.5))
                p.drawLine(polar(R * 0.935, edge), polar(R * 0.995, edge))
            arc(R * 0.965, start + 64, 14, 1.2, self._c(110))

        # The ring of text.
        self._draw_layer(p, center, self._layer("text", R, self._ring_of_text), -t * 5 * speed)

        # Ticks, turning the other way, with triangle markers.
        self._draw_layer(p, center, self._layer("ticks", R, self._ticks), -t * 10 * speed)

        # Orbiting data points with fading trails.
        for radius, rate, phase in ((0.71, 40, 0), (0.71, 40, 180), (0.685, -65, 90), (0.735, 25, 250)):
            angle = (t * rate * speed + phase) % 360
            trail = -28 if rate > 0 else 28
            for s in range(6):
                arc(R * radius, angle + trail * s / 6, trail / 6, 2, self._c(120 * (1 - s / 6)), Qt.FlatCap)
            p.setPen(Qt.NoPen)
            p.setBrush(self._c(255, 160))
            p.drawEllipse(polar(R * radius, angle), R * 0.012 + 1, R * 0.012 + 1)

        # Segmented ring with a running pulse; while thinking, two comets chase round it.
        pulse_at = (t * 120 * speed) % 360
        for k in range(36):
            start = k * 10 - t * 18 * speed
            distance = abs(((start + 4 - pulse_at) + 180) % 360 - 180)
            lit = max(0.0, 1 - distance / 60)
            width = R * (0.05 if k % 3 == 0 else 0.032)
            arc(R * 0.615, start, 6.5, width, self._c(70 + 70 * breathe + 115 * lit, 100 + int(40 * lit)))
        if state == "thinking":
            spin = (t * 300) % 360
            for head in (spin, spin + 180):
                for s in range(10):
                    arc(R * 0.665, head - s * 6, 6, 4 - s * 0.3, self._c(240 * (1 - s / 10), 130), Qt.RoundCap)

        # Voice spectrum, drawn in a few batches of similar brightness.
        base = R * 0.445
        batches = [[], [], [], []]
        for i, v in enumerate(self.bars):
            a = math.radians(i * 360 / self.BARS - 90)
            length = R * 0.13 * v + 1
            batches[min(3, int(v * 4))].append(QLineF(cx + base * math.cos(a), cy + base * math.sin(a),
                                                      cx + (base + length) * math.cos(a), cy + (base + length) * math.sin(a)))
        for n, lines in enumerate(batches):
            if lines:
                p.setPen(QPen(self._c(90 + 160 * (n + 0.5) / 4, 130), max(1.5, R * 0.011), cap=Qt.RoundCap))
                p.drawLines(lines)

        # Coils around the core, brighter as Jarvis speaks.
        self._draw_layer(p, center, self._layer("coils", R, self._coils), t * 8 * speed, 0.55 + 0.25 * breathe + 0.3 * self.level)

        # Hex core frame and a dashed inner ring.
        p.save()
        p.translate(center)
        p.rotate(-t * 15 * speed)
        hexagon = QPolygonF([QPointF(R * 0.27 * math.cos(math.radians(60 * k)), R * 0.27 * math.sin(math.radians(60 * k))) for k in range(6)])
        p.setBrush(Qt.NoBrush)
        p.setPen(QPen(self._c(200, 120), 1.6))
        p.drawPolygon(hexagon)
        p.restore()
        for k in range(16):
            arc(R * 0.235, k * 22.5 + t * 40 * speed, 12, 1.4, self._c(170, 130))

        # The core, with lens-flare streaks.
        core_r = R * (0.19 + 0.025 * breathe + 0.06 * self.level)
        core = QRadialGradient(center, core_r)
        core.setColorAt(0.0, QColor(255, 255, 255, 255))
        core.setColorAt(0.30, self._c(245, 150))
        core.setColorAt(0.70, self._c(130))
        core.setColorAt(1.0, self._c(0))
        p.setPen(Qt.NoPen)
        p.setBrush(QBrush(core))
        p.drawEllipse(center, core_r, core_r)
        flare = 0.35 + 0.25 * breathe + 0.4 * self.level
        for horizontal, length in ((True, R * 0.62), (False, R * 0.30)):
            streak = QLinearGradient(QPointF(cx - length, cy) if horizontal else QPointF(cx, cy - length),
                                     QPointF(cx + length, cy) if horizontal else QPointF(cx, cy + length))
            streak.setColorAt(0.0, self._c(0))
            streak.setColorAt(0.5, QColor(255, 255, 255, int(150 * flare)))
            streak.setColorAt(1.0, self._c(0))
            p.setBrush(QBrush(streak))
            thickness = max(1.0, R * 0.008)
            if horizontal:
                p.drawRect(QRectF(cx - length, cy - thickness / 2, length * 2, thickness))
            else:
                p.drawRect(QRectF(cx - thickness / 2, cy - length, thickness, length * 2))

        # Listening ripples.
        for prog in self.ripples:
            arc(R * (0.30 + 0.70 * prog), 0, 360, 2, self._c(170 * (1 - prog), 120))
        p.end()


# ───────────────────────────── HUD stats ─────────────────────────────
class StatBar(QWidget):
    def __init__(self, name, higher_is_better=False, parent=None):
        super().__init__(parent)
        self.name, self.value, self.text = name, 0.0, "--"
        self.higher_is_better = higher_is_better
        self.setFixedHeight(34)

    def set(self, value, text):
        self.value, self.text = max(0.0, min(1.0, value)), text
        self.update()

    def paintEvent(self, event):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        w = self.width()
        p.setPen(QColor(MUTED))
        p.setFont(QFont(FONT, 8, QFont.DemiBold))
        p.drawText(QRectF(0, 0, w, 16), Qt.AlignLeft | Qt.AlignVCenter, self.name)
        p.setPen(QColor(TEXT))
        p.setFont(QFont(MONO, 9))
        p.drawText(QRectF(0, 0, w, 16), Qt.AlignRight | Qt.AlignVCenter, self.text)
        track = QRectF(0, 22, w, 5)
        p.setPen(Qt.NoPen)
        p.setBrush(QColor(41, 208, 255, 30))
        p.drawRoundedRect(track, 2.5, 2.5)
        load = 1 - self.value if self.higher_is_better else self.value
        color = QColor(ACCENT) if load < 0.75 else (QColor(255, 176, 46) if load < 0.9 else QColor(255, 72, 72))
        grad = QLinearGradient(0, 0, w, 0)
        grad.setColorAt(0, QColor(color.red(), color.green(), color.blue(), 120))
        grad.setColorAt(1, color)
        p.setBrush(QBrush(grad))
        p.drawRoundedRect(QRectF(0, 22, w * self.value, 5), 2.5, 2.5)
        p.end()


class SystemStats(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        grid = QGridLayout(self)
        grid.setContentsMargins(0, 0, 0, 0)
        grid.setHorizontalSpacing(18)
        grid.setVerticalSpacing(6)
        self.cpu, self.ram, self.disk = (StatBar(n) for n in ("CPU", "MEMORY", "DISK"))
        self.batt = StatBar("POWER", higher_is_better=True)
        for i, bar in enumerate((self.cpu, self.ram, self.disk, self.batt)):
            grid.addWidget(bar, i // 2, i % 2)
        self._timer = QTimer(self, timeout=self.refresh, interval=1500)
        if psutil:
            psutil.cpu_percent(None)
            self.refresh()
            self._timer.start()

    def refresh(self):
        cpu = psutil.cpu_percent(None)
        self.cpu.set(cpu / 100, f"{cpu:.0f}%")
        mem = psutil.virtual_memory()
        self.ram.set(mem.percent / 100, f"{mem.used / 2**30:.1f} / {mem.total / 2**30:.0f} GB")
        try:
            disk = psutil.disk_usage("C:\\" if sys.platform.startswith("win") else "/")
            self.disk.set(disk.percent / 100, f"{disk.percent:.0f}%")
        except Exception:
            self.disk.set(0, "n/a")
        batt = psutil.sensors_battery() if hasattr(psutil, "sensors_battery") else None
        if batt:
            self.batt.set(batt.percent / 100, f"{batt.percent:.0f}%{' ⚡' if batt.power_plugged else ''}")
        else:
            self.batt.set(1.0, "AC")


# ───────────────────────────── chat ─────────────────────────────
class Bubble(QFrame):
    def __init__(self, role, text, typewriter=False, parent=None):
        super().__init__(parent)
        self.role = role
        outer = QHBoxLayout(self)
        outer.setContentsMargins(0, 2, 0, 2)

        card = QFrame()
        card_layout = QVBoxLayout(card)
        card_layout.setContentsMargins(14, 9, 14, 10)
        card_layout.setSpacing(3)

        header = QLabel(("JARVIS" if role == "jarvis" else "YOU" if role == "user" else "SYSTEM")
                        + "   " + datetime.datetime.now().strftime("%H:%M"))
        header.setStyleSheet(f"color: {ACCENT if role == 'jarvis' else MUTED}; font-size: 9px; "
                             "font-weight: 600; letter-spacing: 2px; background: transparent; border: none;")
        self.label = QLabel()
        self.label.setWordWrap(True)
        self.label.setTextInteractionFlags(Qt.TextSelectableByMouse)
        self.label.setStyleSheet("background: transparent; border: none;")
        font = QFont(FONT)
        font.setPixelSize(14)
        self.label.setFont(font)
        # QLabel word-wrap picks a narrow width by itself; size it to the text instead (capped).
        metrics = QFontMetrics(font)
        widest = max((metrics.horizontalAdvance(line) for line in text.split("\n")), default=0)
        self.label.setFixedWidth(max(60, min(540, widest + 6)))
        card_layout.addWidget(header)
        card_layout.addWidget(self.label)

        if role == "user":
            card.setStyleSheet("QFrame { background: rgba(41, 208, 255, 38); border: 1px solid rgba(41,208,255,70);"
                               " border-radius: 14px; border-top-right-radius: 4px; }")
            outer.addStretch(1)
            outer.addWidget(card)
        elif role == "jarvis":
            card.setStyleSheet("QFrame { background: rgba(8, 20, 32, 230); border: 1px solid rgba(41,208,255,40);"
                               f" border-left: 3px solid {ACCENT}; border-radius: 14px; border-top-left-radius: 4px; }}")
            outer.addWidget(card)
            outer.addStretch(1)
        else:
            card.setStyleSheet("QFrame { background: rgba(255, 72, 72, 25); border: 1px solid rgba(255,72,72,80);"
                               " border-radius: 10px; }")
            outer.addWidget(card)
            outer.addStretch(1)

        self.full_text = text
        if typewriter:
            self._pos = 0
            self._timer = QTimer(self, timeout=self._type, interval=12)
            self._timer.start()
        else:
            self.label.setText(text)

    def _type(self):
        self._pos += max(2, len(self.full_text) // 60)  # long answers type faster
        self.label.setText(self.full_text[:self._pos])
        if self._pos >= len(self.full_text):
            self._timer.stop()


class ChatView(QScrollArea):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWidgetResizable(True)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        container = QWidget()
        container.setStyleSheet("background: transparent;")
        self.layout_ = QVBoxLayout(container)
        self.layout_.setContentsMargins(6, 6, 10, 6)
        self.layout_.setSpacing(6)
        self.layout_.addStretch(1)
        self.setWidget(container)
        self.viewport().setStyleSheet("background: transparent;")
        self.verticalScrollBar().rangeChanged.connect(lambda _min, mx: self.verticalScrollBar().setValue(mx))

    def add(self, role, text):
        self.layout_.addWidget(Bubble(role, text, typewriter=(role == "jarvis")))

    def clear(self):
        while self.layout_.count() > 1:
            item = self.layout_.takeAt(1)
            if item.widget():
                item.widget().deleteLater()


# ───────────────────────────── backend worker ─────────────────────────────
class AssistantWorker(QObject):
    """Runs on its own thread: speech recognition, the LLM pipeline and text to speech."""
    state = pyqtSignal(str)
    status = pyqtSignal(str)
    user_said = pyqtSignal(str)
    reply = pyqtSignal(str, str)       # role, text
    ready = pyqtSignal(bool)
    exit_requested = pyqtSignal()
    heard_nothing = pyqtSignal()       # a conversation ends when nobody speaks
    conversation_ended = pyqtSignal()  # "that's all"
    sleep_requested = pyqtSignal()     # "go to sleep"

    def __init__(self):
        super().__init__()
        self.handle_query = None
        self._stop_speaking = False
        self.voice_enabled = True

    def stop_speaking(self):
        # called from the GUI thread; a plain bool flag is safe here
        self._stop_speaking = True

    @pyqtSlot()
    def boot(self):
        self.state.emit("booting")
        self.status.emit("Loading modules")
        try:
            from Backend.CloudSync import enabled as cloud_enabled
            from Backend.Personality import greeting
            if cloud_enabled():
                from Backend.CloudAssistant import handle_query
                self.status.emit("Connecting to the cloud")
            else:
                from Backend.Assistant import handle_query
            self.handle_query = handle_query
        except Exception as e:
            self.state.emit("offline")
            self.status.emit("Backend failed to start")
            self.reply.emit("system", f"Startup error: {e}\n\nCheck your .env file (see .env.example) "
                                      "and that every package in requirements.txt is installed.")
            self.ready.emit(False)
            return
        self.ready.emit(True)
        self._respond(greeting())

    def _control_phrase(self, text):
        """Handles "that's all" and "go to sleep" here, rather than asking the AI. True if it was one."""
        said = " ".join(re.sub(r"[^a-z ]", "", text.lower()).split())  # "That's all." -> "thats all"
        if SLEEP_PHRASE.search(said):
            self.sleep_requested.emit()
            self._respond("Going to sleep, sir. Tap me when you need me.")
            return True
        if END_PHRASE.fullmatch(said):
            self.conversation_ended.emit()
            self._respond("Very good, sir.")
            return True
        return False

    @pyqtSlot(str)
    def process(self, text):
        if not self.handle_query:
            return
        if self._control_phrase(text):
            return
        self.state.emit("thinking")
        try:
            answer, should_exit = self.handle_query(text, on_status=self.status.emit)
        except Exception as e:
            print(f"Error handling query: {e}")
            answer, should_exit = "I'm afraid something went wrong on my end.", False
        self._respond(answer)
        if should_exit:
            self.exit_requested.emit()

    @pyqtSlot()
    def listen(self):
        if not self.handle_query:
            return
        from Backend.CloudAssistant import call_active
        if call_active.is_set():
            self.status.emit("On a call, so I'm not listening")
            return
        self.state.emit("listening")
        self.status.emit("Listening…")
        try:
            from Backend.SpeechToText import listen_to_speech
            text = listen_to_speech()
        except Exception as e:
            print(f"Speech recognition error: {e}")
            text = None
        if not text:
            self.heard_nothing.emit()
            self.state.emit("idle")
            self.status.emit("Didn't catch that")
            return
        self.user_said.emit(text)
        self.process(text)

    def _respond(self, text):
        self.reply.emit("jarvis", text)
        from Backend.CloudAssistant import call_active
        if self.voice_enabled and not call_active.is_set():
            self.state.emit("speaking")
            self.status.emit("Speaking")
            self._stop_speaking = False
            try:
                from Backend.TextToSpeech import TextToSpeech
                TextToSpeech(text, lambda r=None: not self._stop_speaking)
            except Exception as e:
                print(f"TTS error: {e}")
        self.state.emit("idle")
        self.status.emit("Awaiting your command")


END_PHRASE = re.compile(r"((thank you|thanks|ok|okay) )?(thats all|that is all|nothing else|never ?mind|thats it)( (jarvis|for now|thanks|thank you))?")
SLEEP_PHRASE = re.compile(r"\b(go to sleep|sleep mode|stop listening)\b")


def beep():
    """A short tone to say Jarvis is listening, played in the background so the window doesn't wait."""
    if sys.platform == "win32":
        import winsound
        threading.Thread(target=winsound.Beep, args=(1100, 90), daemon=True).start()


class WakeListener(QObject):
    """Runs the "Hey Jarvis" detector (Backend/WakeWord.py) in its own process, and signals each time it's heard.

    Its own process, because its audio and AI libraries could clash with the window's. If it stops, it's restarted.
    """
    heard = pyqtSignal()

    def __init__(self):
        super().__init__()
        self.running = True
        self.process = None

    def start(self):
        threading.Thread(target=self._loop, daemon=True).start()

    def stop(self):
        self.running = False
        if self.process and self.process.poll() is None:
            self.process.terminate()

    def _loop(self):
        import subprocess
        from Backend.config import ROOT_DIR
        failures = 0
        while self.running and failures < 5:
            started = time.time()
            try:
                self.process = subprocess.Popen(
                    [sys.executable, "-m", "Backend.WakeWord"], cwd=ROOT_DIR, text=True, bufsize=1,
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    env={**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8"},
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
                for line in self.process.stdout:
                    if line.startswith("WAKE"):
                        self.heard.emit()
                    elif not line.startswith("READY"):
                        print(f"Wake word: {line.rstrip()}")
            except OSError as e:
                print(f"Wake word couldn't start: {e}")
            if not self.running:
                return
            failures = failures + 1 if time.time() - started < 60 else 0  # only give up if it keeps failing quickly
            time.sleep(5)
        print("Wake word stopped after repeated failures")


class SyncWorker(QObject):
    """Background loop (cloud mode only): shows phone conversations and runs commands sent to the laptop."""
    message = pyqtSignal(str, str)      # role, text
    status = pyqtSignal(str)
    devices = pyqtSignal(dict)

    def __init__(self):
        super().__init__()
        self.running = True
        self.last_activity = time.time()

    def start(self):
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        from Backend.CloudSync import CloudClient, CloudError
        from Backend.CloudAssistant import run_laptop_command, start_ai_call
        client = CloudClient()
        first = True
        while self.running:
            try:
                data = client.sync()
                messages = data.get("messages", [])
                if first:
                    # show the tail of the shared conversation for continuity
                    for m in messages[-8:]:
                        self.message.emit("user" if m["role"] == "user" else "jarvis", self._label(m))
                    first = False
                else:
                    for m in messages:
                        if m.get("device") != "laptop":
                            self.message.emit("user" if m["role"] == "user" else "jarvis", self._label(m))
                            self.last_activity = time.time()
                for cmd in data.get("commands", []):
                    if cmd.get("type") == "laptop_command":
                        self.status.emit(f"From phone: {cmd['command']}")
                        self.message.emit("jarvis", f"Running \"{cmd['command']}\", as requested from your phone.")
                        try:
                            run_laptop_command(cmd["command"])
                        except Exception as e:
                            print(f"Command failed: {e}")
                    elif cmd.get("type") == "ai_call":
                        start_ai_call(cmd, client, self.message.emit, self.status.emit)
                    client.done(cmd["id"])
                    self.last_activity = time.time()
                self.devices.emit(data.get("devices", {}))
            except CloudError as e:
                print(f"Sync: {e}")
            except Exception as e:
                print(f"Sync error: {e}")
            # Each check costs the server a little (Netlify's free plan counts every request), so when nothing has
            # happened for two minutes, check once a minute.
            active = time.time() - self.last_activity < 120
            time.sleep(5 if active else 60)

    @staticmethod
    def _label(m):
        prefix = "📱 " if m.get("device") == "phone" and m["role"] == "user" else ""
        return prefix + m["content"]


# ───────────────────────────── window chrome ─────────────────────────────
class TitleBar(QWidget):
    def __init__(self, window):
        super().__init__(window)
        self.window_ = window
        self._drag = None
        self.setFixedHeight(54)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(20, 8, 10, 4)

        names = QVBoxLayout()
        names.setSpacing(0)
        title = QLabel("J.A.R.V.I.S")
        title.setObjectName("Title")
        sub = QLabel("JUST A RATHER VERY INTELLIGENT SYSTEM")
        sub.setObjectName("Subtitle")
        names.addWidget(title)
        names.addWidget(sub)
        lay.addLayout(names)
        lay.addStretch(1)

        self.clock = QLabel()
        self.clock.setObjectName("Clock")
        lay.addWidget(self.clock)
        lay.addSpacing(16)
        self._tick()
        QTimer(self, timeout=self._tick, interval=1000).start()

        for text, slot, name in (("—", window.showMinimized, "WinBtn"),
                                 ("☐", self._toggle_max, "WinBtn"),
                                 ("✕", window.close, "CloseBtn")):
            b = QPushButton(text)
            b.setObjectName(name)
            b.setCursor(Qt.PointingHandCursor)
            b.clicked.connect(slot)
            lay.addWidget(b)

    def _tick(self):
        now = datetime.datetime.now()
        self.clock.setText(now.strftime("%a %d %b   %H:%M:%S").upper())

    def _toggle_max(self):
        self.window_.showNormal() if self.window_.isMaximized() else self.window_.showMaximized()

    def mousePressEvent(self, e):
        if e.button() == Qt.LeftButton:
            self._drag = e.globalPos() - self.window_.frameGeometry().topLeft()

    def mouseMoveEvent(self, e):
        if self._drag is not None and e.buttons() & Qt.LeftButton and not self.window_.isMaximized():
            self.window_.move(e.globalPos() - self._drag)

    def mouseReleaseEvent(self, e):
        self._drag = None

    def mouseDoubleClickEvent(self, e):
        self._toggle_max()


class Backdrop(QWidget):
    """Dark gradient with a faint HUD grid and rounded corners."""

    def paintEvent(self, event):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        r = QRectF(self.rect()).adjusted(0.5, 0.5, -0.5, -0.5)
        radius = 0 if self.window().isMaximized() else 16
        grad = QLinearGradient(0, 0, self.width(), self.height())
        grad.setColorAt(0, QColor(6, 14, 24))
        grad.setColorAt(1, QColor(2, 6, 12))
        p.setBrush(QBrush(grad))
        p.setPen(QPen(QColor(41, 208, 255, 60), 1))
        p.drawRoundedRect(r, radius, radius)

        p.setClipRect(r.adjusted(2, 2, -2, -2))
        p.setPen(QPen(QColor(41, 208, 255, 10), 1))
        step = 32
        for x in range(0, self.width(), step):
            p.drawLine(x, 0, x, self.height())
        for y in range(0, self.height(), step):
            p.drawLine(0, y, self.width(), y)
        p.end()


def make_icon():
    pm = QPixmap(64, 64)
    pm.fill(Qt.transparent)
    p = QPainter(pm)
    p.setRenderHint(QPainter.Antialiasing)
    g = QRadialGradient(QPointF(32, 32), 30)
    g.setColorAt(0, QColor(255, 255, 255))
    g.setColorAt(0.4, QColor(ACCENT))
    g.setColorAt(1, QColor(41, 208, 255, 0))
    p.setBrush(QBrush(g))
    p.setPen(QPen(QColor(ACCENT), 3))
    p.drawEllipse(QPointF(32, 32), 28, 28)
    p.end()
    return QIcon(pm)


# ───────────────────────────── main window ─────────────────────────────
class MainWindow(QMainWindow):
    request_text = pyqtSignal(str)
    request_listen = pyqtSignal()

    def __init__(self, start_backend=True):
        super().__init__()
        from Backend.config import ASSISTANT_VOICE, ASSISTANT_NAME
        self.setWindowTitle(ASSISTANT_NAME)
        self.setWindowIcon(make_icon())
        self.setWindowFlags(Qt.FramelessWindowHint | Qt.Window)
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.resize(1180, 720)
        self.setMinimumSize(940, 600)
        self.busy = True
        self.state = "booting"

        root = Backdrop()
        self.setCentralWidget(root)
        outer = QVBoxLayout(root)
        outer.setContentsMargins(1, 1, 1, 1)
        outer.setSpacing(0)
        outer.addWidget(TitleBar(self))

        body = QHBoxLayout()
        body.setContentsMargins(18, 8, 18, 6)
        body.setSpacing(16)
        outer.addLayout(body, 1)

        # ── left: reactor + status + stats + quick actions
        left = QFrame()
        left.setObjectName("Panel")
        left.setFixedWidth(400)
        lv = QVBoxLayout(left)
        lv.setContentsMargins(20, 14, 20, 18)
        lv.setSpacing(8)

        self.reactor = ArcReactor()
        self.reactor.clicked.connect(self.on_reactor_clicked)
        lv.addWidget(self.reactor, 1)

        self.state_label = QLabel(STATE_LABELS["booting"])
        self.state_label.setObjectName("StateLabel")
        self.state_label.setAlignment(Qt.AlignCenter)
        lv.addWidget(self.state_label)
        self.status_label = QLabel("Loading modules")
        self.status_label.setObjectName("StatusLabel")
        self.status_label.setAlignment(Qt.AlignCenter)
        self.status_label.setWordWrap(True)
        lv.addWidget(self.status_label)
        lv.addSpacing(10)

        if psutil:
            lv.addWidget(self._section("SYSTEM DIAGNOSTICS"))
            lv.addWidget(SystemStats())
            lv.addSpacing(8)

        lv.addWidget(self._section("QUICK COMMANDS"))
        chips = QGridLayout()
        chips.setSpacing(6)
        self.chips = []
        for i, (label, query) in enumerate(QUICK_ACTIONS):
            b = QPushButton(label)
            b.setObjectName("Chip")
            b.setCursor(Qt.PointingHandCursor)
            b.clicked.connect(lambda _=False, q=query: self.send(q))
            chips.addWidget(b, i // 2, i % 2)
            self.chips.append(b)
        lv.addLayout(chips)
        body.addWidget(left)

        # ── right: chat
        right = QFrame()
        right.setObjectName("Panel")
        rv = QVBoxLayout(right)
        rv.setContentsMargins(18, 14, 18, 16)
        rv.setSpacing(10)

        header = QHBoxLayout()
        header.addWidget(self._section("COMMS LOG"))
        header.addStretch(1)
        self.voice_btn = QPushButton("🔊 Voice on")
        self.voice_btn.setObjectName("GhostBtn")
        self.voice_btn.setCursor(Qt.PointingHandCursor)
        self.voice_btn.clicked.connect(self.toggle_voice)
        header.addWidget(self.voice_btn)
        clear_btn = QPushButton("Clear")
        clear_btn.setObjectName("GhostBtn")
        clear_btn.setCursor(Qt.PointingHandCursor)
        header.addWidget(clear_btn)
        rv.addLayout(header)

        self.chat = ChatView()
        clear_btn.clicked.connect(self.chat.clear)
        rv.addWidget(self.chat, 1)

        input_row = QHBoxLayout()
        input_row.setSpacing(10)
        self.input = QLineEdit()
        self.input.setObjectName("Input")
        self.input.setFixedHeight(44)
        self.input.setPlaceholderText("Type a command, say \"Hey Jarvis\", or press Ctrl+Space…")
        self.input.returnPressed.connect(lambda: self.send(self.input.text()))
        input_row.addWidget(self.input, 1)
        self.mic_btn = QPushButton("🎙")
        self.mic_btn.setObjectName("RoundBtn")
        self.mic_btn.setToolTip("Speak (Ctrl+Space)")
        self.mic_btn.setCursor(Qt.PointingHandCursor)
        self.mic_btn.clicked.connect(self.listen)
        input_row.addWidget(self.mic_btn)
        self.send_btn = QPushButton("➤")
        self.send_btn.setObjectName("RoundBtn")
        self.send_btn.setToolTip("Send (Enter)")
        self.send_btn.setCursor(Qt.PointingHandCursor)
        self.send_btn.clicked.connect(lambda: self.send(self.input.text()))
        input_row.addWidget(self.send_btn)
        rv.addLayout(input_row)
        body.addWidget(right, 1)

        for w in (left, right):
            shadow = QGraphicsDropShadowEffect(blurRadius=30, xOffset=0, yOffset=0)
            shadow.setColor(QColor(41, 208, 255, 40))
            w.setGraphicsEffect(shadow)

        footer = QLabel(f"VOICE  {ASSISTANT_VOICE}    •    CTRL+SPACE  talk    •    ESC  stop speaking")
        footer.setObjectName("Footer")
        footer.setAlignment(Qt.AlignCenter)
        footer.setContentsMargins(0, 0, 0, 8)
        outer.addWidget(footer)

        QShortcut(QKeySequence("Ctrl+Space"), self, activated=self.listen)
        QShortcut(QKeySequence("Escape"), self, activated=self.stop_speaking)

        self._set_controls(False)

        # backend thread
        self.thread_ = QThread(self)
        self.worker = AssistantWorker()
        self.worker.moveToThread(self.thread_)
        self.worker.state.connect(self.on_state)
        self.worker.status.connect(self.status_label.setText)
        self.worker.reply.connect(self.chat.add)
        self.worker.user_said.connect(lambda t: self.chat.add("user", t))
        self.worker.exit_requested.connect(lambda: QTimer.singleShot(400, self.close))
        self.worker.heard_nothing.connect(self.end_conversation)
        self.worker.conversation_ended.connect(self.end_conversation)
        self.worker.sleep_requested.connect(self.go_to_sleep)
        self.request_text.connect(self.worker.process)
        self.request_listen.connect(self.worker.listen)
        self.thread_.started.connect(self.worker.boot)
        self.sync = None
        self.wake = None
        self.wallpaper = None      # Jarvis on the desktop wallpaper, when it's on (see Frontend/Wallpaper.py)
        self.tray = None
        self.quitting = False
        self.conversation = False  # after "Hey Jarvis", it keeps listening for follow-ups
        self.sleeping = False      # after "go to sleep", only a tap wakes it
        if start_backend:
            self.thread_.start()
            self.wake = WakeListener()
            self.wake.heard.connect(self.on_wake_word)
            self.wake.start()
            from Backend.CloudSync import enabled as cloud_enabled
            if cloud_enabled():
                self.sync = SyncWorker()
                self.sync.message.connect(self.chat.add)
                self.sync.status.connect(self.status_label.setText)
                self.sync.devices.connect(self.on_devices)
                self.request_text.connect(lambda _t: setattr(self.sync, "last_activity", time.time()))
                self.sync.start()
        self.footer_base = footer.text()
        self.footer = footer

    @staticmethod
    def _section(text):
        label = QLabel(text)
        label.setObjectName("SectionTitle")
        return label

    def _set_controls(self, enabled):
        for w in [self.send_btn, self.mic_btn, *self.chips]:
            w.setEnabled(enabled)

    # ── UI actions
    def send(self, text):
        text = text.strip()
        if not text or self.busy:
            return
        self.input.clear()
        self.chat.add("user", text)
        self.request_text.emit(text)

    def listen(self):
        if self.sleeping:
            self.sleeping = False
            if self.wallpaper:
                self.wallpaper.asleep = False
            self.show_status("Awake")
        if not self.busy:
            self.request_listen.emit()

    def on_wake_word(self):
        from Backend.CloudAssistant import call_active
        if self.sleeping or call_active.is_set() or self.state not in ("idle", "speaking"):
            return
        self.conversation = True
        beep()
        if self.state == "speaking":
            self.stop_speaking()  # it listens once it has stopped (see on_state)
        else:
            self.listen()

    def show_status(self, text):
        self.status_label.setText(text)
        if self.wallpaper:
            self.wallpaper.set_status(text)

    def bring_to_front(self):
        self.showNormal()
        self.raise_()
        self.activateWindow()

    def quit_jarvis(self):
        self.quitting = True
        self.close()

    def add_tray_icon(self):
        """An icon by the clock, so Jarvis keeps running with its window closed."""
        from PyQt5.QtWidgets import QMenu, QSystemTrayIcon
        if not QSystemTrayIcon.isSystemTrayAvailable():
            return
        self.tray = QSystemTrayIcon(make_icon(), self)
        self.tray.setToolTip("J.A.R.V.I.S. Say \"Hey Jarvis\"")
        menu = QMenu()
        menu.addAction("Open Jarvis", self.bring_to_front)
        menu.addAction("Talk", self.listen)
        menu.addSeparator()
        menu.addAction("Quit Jarvis", self.quit_jarvis)
        self.tray.setContextMenu(menu)
        self.tray.activated.connect(lambda reason: self.bring_to_front() if reason == QSystemTrayIcon.Trigger else None)
        self.tray.show()

    def end_conversation(self):
        self.conversation = False

    def go_to_sleep(self):
        self.conversation = False
        self.sleeping = True
        if self.wallpaper:
            self.wallpaper.asleep = True
            self.show_status("Asleep. Click me to wake me")

    def toggle_sleep(self):
        if self.sleeping:
            self.sleeping = False
            if self.wallpaper:
                self.wallpaper.asleep = False
            self.show_status("Awake. Say \"Hey Jarvis\"")
        else:
            self.go_to_sleep()

    def stop_speaking(self):
        if self.state == "speaking":
            self.worker.stop_speaking()

    def on_reactor_clicked(self):
        if self.state == "speaking":
            self.stop_speaking()
        else:
            self.listen()

    def toggle_voice(self):
        self.worker.voice_enabled = not self.worker.voice_enabled
        self.voice_btn.setText("🔊 Voice on" if self.worker.voice_enabled else "🔇 Voice off")

    def on_state(self, state):
        self.state = state
        self.busy = state != "idle"
        self.reactor.set_state(state)
        color = STATE_COLORS.get(state, STATE_COLORS["idle"]).name()
        self.state_label.setText(STATE_LABELS.get(state, state.upper()))
        self.state_label.setStyleSheet(f"color: {color};")
        self._set_controls(state == "idle")
        if state == "idle" and self.conversation and not self.sleeping:
            QTimer.singleShot(250, self.listen)  # a follow-up, without saying "Hey Jarvis" again
        elif state == "idle" and self.sleeping:
            self.show_status("Asleep. Click me, or press Ctrl+Space, to wake me")
        self.mic_btn.setProperty("active", state == "listening")
        self.mic_btn.style().unpolish(self.mic_btn)
        self.mic_btn.style().polish(self.mic_btn)
        if state == "idle":
            self.input.setFocus()

    def on_devices(self, devices):
        phone = devices.get("phone", {})
        dot = "● PHONE ONLINE" if phone.get("online") else "○ PHONE OFFLINE"
        self.footer.setText(f"{dot}    •    {self.footer_base}")

    def closeEvent(self, event):
        if (self.tray or self.wallpaper) and not self.quitting:
            # Closing the window keeps Jarvis running on the wallpaper (and by the clock, without a wallpaper).
            event.ignore()
            self.hide()
            if self.tray and not getattr(self, "_told_about_tray", False):
                self.tray.showMessage("Jarvis is still running", "Say \"Hey Jarvis\", or click the icon by the clock. Quit from its menu.")
                self._told_about_tray = True
            return
        if self.tray:
            self.tray.hide()
        if self.wallpaper:
            self.wallpaper.close()
        if self.wake:
            self.wake.stop()
        if self.sync:
            self.sync.running = False
        self.worker.stop_speaking()
        self.thread_.quit()
        if not self.thread_.wait(1500):
            # Still busy (e.g. waiting on the microphone or a network call): don't hang on exit.
            self.thread_.terminate()
            self.thread_.wait(500)
        super().closeEvent(event)


def GraphicalUserInterface():
    QApplication.setAttribute(Qt.AA_EnableHighDpiScaling, True)
    QApplication.setAttribute(Qt.AA_UseHighDpiPixmaps, True)
    app = QApplication(sys.argv)
    app.setStyleSheet(STYLE)
    app.setQuitOnLastWindowClosed(False)  # closing the window hides it; "Quit Jarvis" ends the app
    window = MainWindow()
    add_wallpaper(window)
    # With the wallpaper, that's the whole app: no window or taskbar icon. Its menu opens the window to type.
    # Without it (turned off, or not supported), the app has its window and an icon by the clock.
    if not window.wallpaper:
        window.add_tray_icon()
        if "--background" not in sys.argv or not window.tray:
            window.show()
    window.destroyed.connect(app.quit)
    app.aboutToQuit.connect(lambda: window.wallpaper and window.wallpaper.close())
    sys.exit(app.exec_())


def add_wallpaper(window):
    """Puts Jarvis on the desktop wallpaper. Turn it off with JARVIS_WALLPAPER=off in .env."""
    if sys.platform != "win32" or os.getenv("JARVIS_WALLPAPER", "on").lower() in ("0", "off", "false", "no"):
        return
    try:
        from Frontend.Wallpaper import WallpaperWindow
        wallpaper = WallpaperWindow()
        if not wallpaper.attach():
            wallpaper.deleteLater()
            return
    except Exception as e:
        print(f"Wallpaper couldn't start: {e}")
        return
    window.wallpaper = wallpaper
    window.worker.state.connect(wallpaper.set_state)
    window.worker.status.connect(wallpaper.set_status)
    window.worker.reply.connect(wallpaper.set_reply)
    if window.sync:
        window.sync.message.connect(wallpaper.set_reply)
    wallpaper.listen_requested.connect(window.listen)
    wallpaper.open_requested.connect(window.bring_to_front)
    wallpaper.sleep_toggled.connect(window.toggle_sleep)
    wallpaper.quit_requested.connect(window.quit_jarvis)


if __name__ == "__main__":
    GraphicalUserInterface()
