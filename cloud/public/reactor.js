// Animated arc reactor (canvas port of the desktop HUD orb).
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
  const BARS = 72;

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
      this.last = performance.now();
      this._loop = this._loop.bind(this);
      requestAnimationFrame(this._loop);
    }

    setState(state) {
      if (state === "listening" && this.state !== "listening") this.ripples = [0];
      this.state = state;
    }

    rgba(a, lighten = 0) {
      const [r, g, b] = this.color.map((c) => Math.min(255, c + lighten));
      return `rgba(${r | 0},${g | 0},${b | 0},${Math.max(0, Math.min(1, a))})`;
    }

    _resize() {
      const dpr = window.devicePixelRatio || 1;
      const { width, height } = this.canvas.getBoundingClientRect();
      if (this.canvas.width !== Math.round(width * dpr) || this.canvas.height !== Math.round(height * dpr)) {
        this.canvas.width = Math.round(width * dpr);
        this.canvas.height = Math.round(height * dpr);
      }
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { w: width, h: height };
    }

    _update(dt) {
      this.t += dt;
      const target = COLORS[this.state] || COLORS.idle;
      this.color = this.color.map((c, i) => c + (target[i] - c) * Math.min(1, dt * 5));
      let goal = 0;
      if (this.state === "speaking") {
        goal = 0.35 + 0.65 * Math.abs(Math.sin(this.t * 7.3) * Math.sin(this.t * 2.1 + 1)) + (Math.random() - 0.5) * 0.2;
      } else if (this.state === "listening") {
        goal = 0.25 + 0.15 * Math.sin(this.t * 4);
      }
      this.level += (goal - this.level) * Math.min(1, dt * 11);
      for (let i = 0; i < BARS; i++) {
        const wave = 0.5 + 0.5 * Math.sin(i * 0.55 + this.t * 9) * Math.sin(i * 0.21 - this.t * 5);
        const g = this.level * (0.35 + 0.65 * wave) * (0.75 + Math.random() * 0.25);
        this.bars[i] += (g - this.bars[i]) * 0.3;
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
        this._update(dt);
        this._draw();
      }
      requestAnimationFrame(this._loop);
    }

    _draw() {
      const { w, h } = this._resize();
      const c = this.ctx;
      const cx = w / 2, cy = h / 2;
      const R = Math.min(w, h) / 2 - 4;
      const t = this.t;
      const speed = { thinking: 3.2, speaking: 1.6, listening: 1.3 }[this.state] || 1;
      const breathe = 0.5 + 0.5 * Math.sin(t * (this.state === "idle" ? 2.4 : 4));
      const arc = (r, start, span, width, color, cap = "butt") => {
        c.beginPath();
        c.lineWidth = width;
        c.lineCap = cap;
        c.strokeStyle = color;
        c.arc(cx, cy, r, start, start + span);
        c.stroke();
      };
      const deg = Math.PI / 180;
      c.clearRect(0, 0, w, h);

      // glow
      let g = c.createRadialGradient(cx, cy, 0, cx, cy, R);
      g.addColorStop(0, this.rgba(0.28 + 0.15 * this.level));
      g.addColorStop(0.45, this.rgba(0.09));
      g.addColorStop(1, this.rgba(0));
      c.fillStyle = g;
      c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.fill();

      // ripples
      for (const p of this.ripples) arc(R * (0.35 + 0.65 * p), 0, Math.PI * 2, 2, this.rgba(0.63 * (1 - p)));

      // outer ring and rotating arcs
      arc(R * 0.98, 0, Math.PI * 2, 1, this.rgba(0.22));
      const rot = ((t * 22 * speed) % 360) * deg;
      for (let k = 0; k < 3; k++) arc(R * 0.94, rot + k * 120 * deg, 70 * deg, 3, this.rgba(0.8));
      for (let k = 0; k < 3; k++) arc(R * 0.94, rot + (k * 120 + 78) * deg, 30 * deg, 1.5, this.rgba(0.35));

      // ticks
      c.save();
      c.translate(cx, cy);
      c.rotate(-t * 8 * speed * deg);
      for (let i = 0; i < 120; i++) {
        const major = i % 10 === 0;
        const a = i * 3 * deg;
        const r1 = R * 0.8, r2 = R * (major ? 0.86 : 0.83);
        c.beginPath();
        c.lineWidth = major ? 2 : 1;
        c.strokeStyle = this.rgba(major ? 0.67 : 0.27);
        c.moveTo(r1 * Math.cos(a), r1 * Math.sin(a));
        c.lineTo(r2 * Math.cos(a), r2 * Math.sin(a));
        c.stroke();
      }
      c.restore();

      if (this.state === "thinking") {
        const spin = ((t * 260) % 360) * deg;
        arc(R * 0.72, spin, 90 * deg, 4, this.rgba(0.9, 30), "round");
        arc(R * 0.72, spin + Math.PI, 90 * deg, 4, this.rgba(0.9, 30), "round");
      }

      const seg = ((-t * 35 * speed) % 360) * deg;
      for (let k = 0; k < 12; k++) arc(R * 0.64, seg + k * 30 * deg, 18 * deg, Math.max(3, R * 0.04), this.rgba(0.47 + 0.31 * breathe));

      // voice bars
      if (this.level > 0.02) {
        const base = R * 0.4;
        c.lineCap = "round";
        c.lineWidth = 2.5;
        for (let i = 0; i < BARS; i++) {
          const v = this.bars[i];
          const a = (i * 360 / BARS - 90) * deg;
          const len = R * 0.18 * v;
          c.strokeStyle = this.rgba(0.43 + 0.55 * v, 30);
          c.beginPath();
          c.moveTo(base * Math.cos(a) + cx, base * Math.sin(a) + cy);
          c.lineTo((base + len) * Math.cos(a) + cx, (base + len) * Math.sin(a) + cy);
          c.stroke();
        }
      }

      // triangle
      c.save();
      c.translate(cx, cy);
      c.rotate(t * 12 * speed * deg);
      c.strokeStyle = this.rgba(0.43);
      c.lineWidth = 1.5;
      c.beginPath();
      [-90, 30, 150, -90].forEach((a, i) => {
        const x = R * 0.36 * Math.cos(a * deg), y = R * 0.36 * Math.sin(a * deg);
        i ? c.lineTo(x, y) : c.moveTo(x, y);
      });
      c.stroke();
      c.restore();

      // core
      const coreR = R * (0.22 + 0.03 * breathe + 0.07 * this.level);
      g = c.createRadialGradient(cx, cy, 0, cx, cy, coreR);
      g.addColorStop(0, "rgba(255,255,255,0.98)");
      g.addColorStop(0.35, this.rgba(0.94, 40));
      g.addColorStop(0.75, this.rgba(0.47));
      g.addColorStop(1, this.rgba(0));
      c.fillStyle = g;
      c.beginPath(); c.arc(cx, cy, coreR, 0, Math.PI * 2); c.fill();
      arc(R * 0.26, 0, Math.PI * 2, 1.5, this.rgba(0.86));
    }
  }

  window.Reactor = Reactor;
})();
