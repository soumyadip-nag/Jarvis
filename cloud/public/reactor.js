// Animated HUD reactor, the same design as the desktop app's (Frontend/Gui.py, ArcReactor): change them together.
// Layers, from the outside in: a radar sweep, framing arcs, a turning ring of text, ticks with markers, orbiting
// data points, a segmented ring with a running pulse, the voice spectrum, coils, a hex core and the core.
// States: booting, idle, listening, thinking, speaking, offline.
(function () {
  const COLORS = {
    booting: [90, 140, 170],
    idle: [41, 208, 255],
    listening: [64, 255, 200],
    thinking: [255, 176, 46],
    speaking: [80, 180, 255],
    offline: [255, 72, 72],
  };
  const LABELS = {
    booting: "INITIALISING", idle: "STANDING BY", listening: "LISTENING",
    thinking: "PROCESSING", speaking: "RESPONDING", offline: "OFFLINE",
  };
  const BARS = 96;
  const DEG = Math.PI / 180;

  class Reactor {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.state = "booting";
      this.color = [...COLORS.booting];
      this.t = 0;
      this.level = 0;
      this.bars = new Array(BARS).fill(0);
      this.ripples = [];
      this.layers = {}; // parts that only rotate, drawn once and then turned: drawing them every frame is slow
      this.last = performance.now();
      this._loop = this._loop.bind(this);
      requestAnimationFrame(this._loop);
    }

    setState(state) {
      if (state === "listening" && this.state !== "listening") this.ripples = [0];
      this.state = state;
    }

    /** The colour, made lighter by `lighter` percent (as Qt's QColor.lighter), at an opacity of 0 to 1. */
    rgba(a, lighter = 100) {
      const [r, g, b] = this.color.map((c) => Math.min(255, (c * lighter) / 100));
      return `rgba(${r | 0},${g | 0},${b | 0},${Math.max(0, Math.min(1, a))})`;
    }

    _resize() {
      const dpr = window.devicePixelRatio || 1;
      const { width, height } = this.canvas.getBoundingClientRect();
      if (this.canvas.width !== Math.round(width * dpr) || this.canvas.height !== Math.round(height * dpr)) {
        this.canvas.width = Math.round(width * dpr);
        this.canvas.height = Math.round(height * dpr);
        this.layers = {};
      }
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { w: width, h: height, dpr };
    }

    /** Moves the animation on by dt seconds. */
    advance(dt) {
      this.t += dt;
      const target = COLORS[this.state] || COLORS.idle;
      this.color = this.color.map((c, i) => c + (target[i] - c) * Math.min(1, dt * 5));
      let goal;
      if (this.state === "speaking") {
        goal = 0.35 + 0.65 * Math.abs(Math.sin(this.t * 7.3) * Math.sin(this.t * 2.1 + 1)) + (Math.random() - 0.5) * 0.2;
      } else if (this.state === "listening") {
        goal = 0.25 + 0.15 * Math.sin(this.t * 4);
      } else {
        goal = 0.06 + 0.03 * Math.sin(this.t * 1.7); // a faint shimmer, so it never looks frozen
      }
      this.level += (goal - this.level) * Math.min(1, dt * 11);
      for (let i = 0; i < BARS; i++) {
        const wave = 0.5 + 0.5 * Math.sin(i * 0.55 + this.t * 9) * Math.sin(i * 0.21 - this.t * 5);
        const g = this.level * (0.35 + 0.65 * wave) * (0.75 + Math.random() * 0.25);
        this.bars[i] += (g - this.bars[i]) * 0.35;
      }
      const grow = this.state === "listening" ? 0.75 : 1.25;
      this.ripples = this.ripples.map((p) => p + dt * grow).filter((p) => p < 1);
      if (this.state === "listening" && (!this.ripples.length || this.ripples[this.ripples.length - 1] > 0.33)) {
        this.ripples.push(0);
      }
    }

    _loop(now) {
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      if (!document.hidden && this.canvas.isConnected && this.canvas.offsetParent !== null) {
        this.advance(dt);
        this.draw();
      }
      requestAnimationFrame(this._loop);
    }

    /** A layer drawn once for this size, state and colour (to the nearest shade). */
    _layer(name, R, dpr, draw) {
      const key = `${Math.round(R)}|${dpr}|${this.state}|${this.color.map((v) => (v / 6) | 0).join(",")}`;
      if (this.layers[name]?.key !== key) {
        const size = Math.ceil(R * 2 + 4);
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = Math.ceil(size * dpr);
        const c = canvas.getContext("2d");
        c.scale(dpr, dpr);
        c.translate(size / 2, size / 2);
        draw.call(this, c, R);
        this.layers[name] = { key, canvas, size };
      }
      return this.layers[name];
    }

    _drawLayer(layer, cx, cy, degrees, opacity = 1) {
      const c = this.ctx;
      c.save();
      c.translate(cx, cy);
      c.rotate(degrees * DEG);
      c.globalAlpha = Math.min(1, opacity);
      c.drawImage(layer.canvas, -layer.size / 2, -layer.size / 2, layer.size, layer.size);
      c.restore();
    }

    _textRing(c, R) {
      const label = LABELS[this.state] || this.state.toUpperCase();
      const text = `J.A.R.V.I.S  •  ${label}  •  NEURAL CORE  •  SYNC PHONE/LAPTOP  •  `;
      const radius = R * 0.885;
      const size = Math.max(6, R * 0.042 * 1.33);
      c.font = `bold ${size}px Consolas, "Roboto Mono", monospace`;
      c.fillStyle = this.rgba(150 / 255, 130);
      c.textAlign = "center";
      // A whole number of repeats, so the text doesn't break where it meets itself.
      const repeats = Math.max(1, Math.round(360 / (((R * 0.042 * 0.95) / radius) / DEG) / text.length));
      const count = repeats * text.length;
      for (let i = 0; i < count; i++) {
        c.save();
        c.rotate((i * 360 / count) * DEG);
        c.fillText(text[i % text.length], 0, -radius);
        c.restore();
      }
    }

    _ticks(c, R) {
      for (let i = 0; i < 120; i++) {
        const major = i % 10 === 0;
        const a = i * 3 * DEG;
        const r1 = R * 0.775, r2 = R * (major ? 0.82 : 0.8);
        c.beginPath();
        c.lineWidth = major ? 2 : 1;
        c.strokeStyle = this.rgba(major ? 190 / 255 : 70 / 255);
        c.moveTo(r1 * Math.cos(a), r1 * Math.sin(a));
        c.lineTo(r2 * Math.cos(a), r2 * Math.sin(a));
        c.stroke();
      }
      c.fillStyle = this.rgba(210 / 255, 130);
      for (let k = 0; k < 4; k++) {
        const a = (k * 90 + 45) * DEG, tip = R * 0.755, base = R * 0.725, half = 2.2 * DEG;
        c.beginPath();
        c.moveTo(tip * Math.cos(a), tip * Math.sin(a));
        c.lineTo(base * Math.cos(a - half), base * Math.sin(a - half));
        c.lineTo(base * Math.cos(a + half), base * Math.sin(a + half));
        c.fill();
      }
    }

    _coils(c, R) {
      const inner = R * 0.3, outer = R * 0.4, halfIn = 11 * DEG, halfOut = 13 * DEG;
      c.fillStyle = this.rgba(70 / 255);
      c.strokeStyle = this.rgba(170 / 255);
      c.lineWidth = 1.2;
      for (let k = 0; k < 10; k++) {
        c.save();
        c.rotate(k * 36 * DEG);
        c.beginPath();
        c.moveTo(inner * Math.cos(-halfIn), inner * Math.sin(-halfIn));
        c.lineTo(outer * Math.cos(-halfOut), outer * Math.sin(-halfOut));
        c.lineTo(outer * Math.cos(halfOut), outer * Math.sin(halfOut));
        c.lineTo(inner * Math.cos(halfIn), inner * Math.sin(halfIn));
        c.closePath();
        c.fill();
        c.stroke();
        c.restore();
      }
    }

    draw() {
      const { w, h, dpr } = this._resize();
      const c = this.ctx;
      const cx = w / 2, cy = h / 2;
      const R = Math.min(w, h) / 2 - 4;
      const t = this.t;
      const state = this.state;
      const speed = { thinking: 3.0, speaking: 1.5, listening: 1.3 }[state] || 1;
      const breathe = 0.5 + 0.5 * Math.sin(t * (state === "idle" ? 2.4 : 4));
      const a255 = (v) => v / 255;
      // Clockwise from 3 o'clock, in degrees, as on the laptop.
      const arc = (r, start, span, width, color, cap = "butt") => {
        c.beginPath();
        c.lineWidth = width;
        c.lineCap = cap;
        c.strokeStyle = color;
        c.arc(cx, cy, r, start * DEG, (start + span) * DEG, span < 0);
        c.stroke();
      };
      const polar = (r, d) => [cx + r * Math.cos(d * DEG), cy + r * Math.sin(d * DEG)];
      c.clearRect(0, 0, w, h);

      // Bloom.
      let g = c.createRadialGradient(cx, cy, 0, cx, cy, R);
      g.addColorStop(0, this.rgba(a255(85 + 50 * this.level)));
      g.addColorStop(0.35, this.rgba(a255(32)));
      g.addColorStop(1, this.rgba(0));
      c.fillStyle = g;
      c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.fill();

      // Radar sweep across the outer band.
      const sweepAngle = (t * 50 * speed) % 360;
      if (c.createConicGradient) {
        const sweep = c.createConicGradient((sweepAngle - 36) * DEG, cx, cy);
        sweep.addColorStop(0, this.rgba(0));
        sweep.addColorStop(0.1, this.rgba(a255(95), 120));
        sweep.addColorStop(0.1001, this.rgba(0));
        sweep.addColorStop(1, this.rgba(0));
        c.fillStyle = sweep;
        c.beginPath();
        c.arc(cx, cy, R * 0.985, 0, Math.PI * 2);
        c.arc(cx, cy, R * 0.7, 0, Math.PI * 2, true);
        c.fill();
      }
      c.beginPath();
      c.lineWidth = 1.5;
      c.strokeStyle = this.rgba(a255(200), 140);
      c.moveTo(...polar(R * 0.7, sweepAngle));
      c.lineTo(...polar(R * 0.985, sweepAngle));
      c.stroke();

      // Hairlines and the framing arcs, with bracket ends.
      arc(R * 0.995, 0, 360, 1, this.rgba(a255(45)));
      arc(R * 0.83, 0, 360, 1, this.rgba(a255(40)));
      const frame = t * 6 * speed;
      for (let k = 0; k < 4; k++) {
        const start = frame + k * 90 + 8;
        arc(R * 0.965, start, 58, Math.max(2, R * 0.018), this.rgba(a255(190)));
        for (const edge of [start, start + 58]) {
          c.beginPath();
          c.lineWidth = 1.5;
          c.strokeStyle = this.rgba(a255(220), 130);
          c.moveTo(...polar(R * 0.935, edge));
          c.lineTo(...polar(R * 0.995, edge));
          c.stroke();
        }
        arc(R * 0.965, start + 64, 14, 1.2, this.rgba(a255(110)));
      }

      // The ring of text, and the ticks turning the other way.
      this._drawLayer(this._layer("text", R, dpr, this._textRing), cx, cy, -t * 5 * speed);
      this._drawLayer(this._layer("ticks", R, dpr, this._ticks), cx, cy, -t * 10 * speed);

      // Orbiting data points with fading trails.
      for (const [radius, rate, phase] of [[0.71, 40, 0], [0.71, 40, 180], [0.685, -65, 90], [0.735, 25, 250]]) {
        const angle = (t * rate * speed + phase) % 360;
        const trail = rate > 0 ? -28 : 28;
        for (let s = 0; s < 6; s++) arc(R * radius, angle + trail * s / 6, trail / 6, 2, this.rgba(a255(120 * (1 - s / 6))));
        c.fillStyle = this.rgba(1, 160);
        c.beginPath();
        c.arc(...polar(R * radius, angle), R * 0.012 + 1, 0, Math.PI * 2);
        c.fill();
      }

      // Segmented ring with a running pulse; while thinking, two comets chase round it.
      const pulseAt = (t * 120 * speed) % 360;
      for (let k = 0; k < 36; k++) {
        const start = k * 10 - t * 18 * speed;
        const distance = Math.abs((((start + 4 - pulseAt) % 360) + 540) % 360 - 180);
        const lit = Math.max(0, 1 - distance / 60);
        arc(R * 0.615, start, 6.5, R * (k % 3 === 0 ? 0.05 : 0.032), this.rgba(a255(70 + 70 * breathe + 115 * lit), 100 + 40 * lit));
      }
      if (state === "thinking") {
        const spin = (t * 300) % 360;
        for (const head of [spin, spin + 180]) {
          for (let s = 0; s < 10; s++) arc(R * 0.665, head - s * 6, 6, 4 - s * 0.3, this.rgba(a255(240 * (1 - s / 10)), 130), "round");
        }
      }

      // Voice spectrum.
      const base = R * 0.445;
      c.lineCap = "round";
      c.lineWidth = Math.max(1.5, R * 0.011);
      for (let n = 0; n < 4; n++) {
        c.beginPath();
        c.strokeStyle = this.rgba(a255(90 + 160 * (n + 0.5) / 4), 130);
        for (let i = 0; i < BARS; i++) {
          const v = this.bars[i];
          if (Math.min(3, (v * 4) | 0) !== n) continue;
          const a = (i * 360 / BARS - 90) * DEG;
          const length = R * 0.13 * v + 1;
          c.moveTo(cx + base * Math.cos(a), cy + base * Math.sin(a));
          c.lineTo(cx + (base + length) * Math.cos(a), cy + (base + length) * Math.sin(a));
        }
        c.stroke();
      }

      // Coils around the core, brighter as Jarvis speaks.
      this._drawLayer(this._layer("coils", R, dpr, this._coils), cx, cy, t * 8 * speed, 0.55 + 0.25 * breathe + 0.3 * this.level);

      // Hex core frame and a dashed inner ring.
      c.save();
      c.translate(cx, cy);
      c.rotate(-t * 15 * speed * DEG);
      c.beginPath();
      for (let k = 0; k <= 6; k++) {
        const x = R * 0.27 * Math.cos(60 * k * DEG), y = R * 0.27 * Math.sin(60 * k * DEG);
        k ? c.lineTo(x, y) : c.moveTo(x, y);
      }
      c.lineWidth = 1.6;
      c.strokeStyle = this.rgba(a255(200), 120);
      c.stroke();
      c.restore();
      for (let k = 0; k < 16; k++) arc(R * 0.235, k * 22.5 + t * 40 * speed, 12, 1.4, this.rgba(a255(170), 130));

      // The core, with lens-flare streaks.
      const coreR = R * (0.19 + 0.025 * breathe + 0.06 * this.level);
      g = c.createRadialGradient(cx, cy, 0, cx, cy, coreR);
      g.addColorStop(0, "rgba(255,255,255,1)");
      g.addColorStop(0.3, this.rgba(a255(245), 150));
      g.addColorStop(0.7, this.rgba(a255(130)));
      g.addColorStop(1, this.rgba(0));
      c.fillStyle = g;
      c.beginPath(); c.arc(cx, cy, coreR, 0, Math.PI * 2); c.fill();
      const flare = 0.35 + 0.25 * breathe + 0.4 * this.level;
      const thickness = Math.max(1, R * 0.008);
      for (const [horizontal, length] of [[true, R * 0.62], [false, R * 0.3]]) {
        g = horizontal ? c.createLinearGradient(cx - length, cy, cx + length, cy) : c.createLinearGradient(cx, cy - length, cx, cy + length);
        g.addColorStop(0, this.rgba(0));
        g.addColorStop(0.5, `rgba(255,255,255,${Math.min(1, 150 * flare / 255)})`);
        g.addColorStop(1, this.rgba(0));
        c.fillStyle = g;
        if (horizontal) c.fillRect(cx - length, cy - thickness / 2, length * 2, thickness);
        else c.fillRect(cx - thickness / 2, cy - length, thickness, length * 2);
      }

      // Listening ripples.
      for (const p of this.ripples) arc(R * (0.3 + 0.7 * p), 0, 360, 2, this.rgba(a255(170 * (1 - p)), 120));
    }
  }

  window.Reactor = Reactor;
})();
