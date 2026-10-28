// Aim state: direction, spin, power, elevation; plus the client-side
// ghost-ball geometry used for the preview overlay.

import { deg2rad, angleDeg, sweepCircle } from './geometry.js';

export class Aim {
  constructor(table, ballR) {
    this.table = table;
    this.ballR = ballR;
    this.V0 = 2.2;
    this.phi = 90;
    this.theta = 0;
    this.a = 0;
    this.b = 0;
  }

  params() {
    return { V0: +this.V0.toFixed(3), phi: +this.phi.toFixed(3),
             theta: +this.theta.toFixed(2), a: +this.a.toFixed(3), b: +this.b.toFixed(3) };
  }

  dir() {
    const r = deg2rad(this.phi);
    return [Math.cos(r), Math.sin(r)];
  }

  // Geometry of the shot from the cue ball: first ball contact (ghost ball)
  // or cushion.  Returns everything render.js needs.
  preview(cueXY, balls) {
    const t = this.table;
    const R = this.ballR;
    const d = this.dir();
    const p = cueXY;

    // cushion intersection along direction d, ball-center limits
    let wallT = Infinity;
    const walls = [
      [d[0] > 0 ? (t.w - R - p[0]) / d[0] : null],
      [d[0] < 0 ? (R - p[0]) / d[0] : null],
      [d[1] > 0 ? (t.l - R - p[1]) / d[1] : null],
      [d[1] < 0 ? (R - p[1]) / d[1] : null],
    ];
    for (const [wv] of walls) {
      if (wv !== null && wv > 0 && wv < wallT) wallT = wv;
    }

    // nearest ball contact
    let hit = null;
    for (const b of balls) {
      if (b.isCue) continue;
      const dist = sweepCircle(p, d, b.xy, 2 * R);
      if (dist !== null && dist < wallT && (!hit || dist < hit.dist)) {
        hit = { dist, ball: b };
      }
    }

    const endT = hit ? hit.dist : wallT;
    const lineEnd = [p[0] + d[0] * endT, p[1] + d[1] * endT];

    let ghost = null, objDir = null, objBall = null;
    if (hit) {
      ghost = lineEnd.slice();
      objBall = hit.ball;
      const ox = hit.ball.xy[0] - ghost[0];
      const oy = hit.ball.xy[1] - ghost[1];
      const n = Math.hypot(ox, oy) || 1;
      objDir = [ox / n, oy / n];
    }

    // cue stick: behind the ball, pull-back scales with power
    const pull = 0.05 + 0.011 * this.V0;
    const stickLen = 1.45;
    const tip = [p[0] - d[0] * (R + pull), p[1] - d[1] * (R + pull)];
    const butt = [tip[0] - d[0] * stickLen, tip[1] - d[1] * stickLen];

    return {
      cue: p,
      dir: d,
      lineEnd,
      ghost,
      objDir,
      objBall,
      ballR: R,
      stick: { tip, butt },
    };
  }
}

// Spin pad widget (a, b) — y up is topspin (b > 0).
export class SpinPad {
  constructor(canvas, onChange) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.a = 0;
    this.b = 0.2;
    this.onChange = onChange;
    this.draw();

    const pos = (ev) => {
      const rect = canvas.getBoundingClientRect();
      const scale = canvas.width / rect.width;
      const x = (ev.clientX - rect.left) * scale;
      const y = (ev.clientY - rect.top) * scale;
      const c = canvas.width / 2;
      let dx = (x - c) / (c - 10), dy = -(y - c) / (c - 10);
      const r = Math.hypot(dx, dy);
      if (r > 1) { dx /= r; dy /= r; }
      this.a = dx;
      this.b = dy;
      this.onChange(this.a, this.b);
      this.draw();
    };

    let dragging = false;
    canvas.addEventListener('pointerdown', (e) => { dragging = true; canvas.setPointerCapture(e.pointerId); pos(e); });
    canvas.addEventListener('pointermove', (e) => { if (dragging) pos(e); });
    canvas.addEventListener('pointerup', () => { dragging = false; });
  }

  set(a, b) {
    this.a = a;
    this.b = b;
    this.draw();
  }

  draw() {
    const g = this.g;
    const c = this.canvas.width / 2;
    const r = c - 10;
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);

    const grad = g.createRadialGradient(c - r * 0.3, c - r * 0.3, r * 0.1, c, c, r);
    grad.addColorStop(0, '#f6de6b');
    grad.addColorStop(1, '#d9a928');
    g.beginPath();
    g.arc(c, c, r, 0, Math.PI * 2);
    g.fillStyle = grad;
    g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.35)';
    g.lineWidth = 2;
    g.stroke();

    g.strokeStyle = 'rgba(0,0,0,0.22)';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(c - r, c); g.lineTo(c + r, c); g.stroke();
    g.beginPath(); g.moveTo(c, c - r); g.lineTo(c, c + r); g.stroke();

    g.beginPath();
    g.arc(c + this.a * r, c - this.b * r, 7, 0, Math.PI * 2);
    g.fillStyle = '#c0392b';
    g.fill();
    g.strokeStyle = '#fff';
    g.lineWidth = 1.5;
    g.stroke();
  }
}
