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
    const minX = Math.min(R, p[0] - 0.02);
    const maxX = Math.max(t.w - R, p[0] + 0.02);
    const minY = Math.min(R, p[1] - 0.02);
    const maxY = Math.max(t.l - R, p[1] + 0.02);
    let wallT = Infinity;
    const walls = [
      d[0] > 1e-9 ? (maxX - p[0]) / d[0] : null,
      d[0] < -1e-9 ? (minX - p[0]) / d[0] : null,
      d[1] > 1e-9 ? (maxY - p[1]) / d[1] : null,
      d[1] < -1e-9 ? (minY - p[1]) / d[1] : null,
    ];
    for (const wv of walls) {
      if (wv !== null && wv > 0 && wv < wallT) wallT = wv;
    }
    if (!Number.isFinite(wallT)) wallT = Math.hypot(t.w, t.l);

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
    const pull = 0.04 + 0.022 * this.V0;
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

// Real-world miscue limit (~50% of ball radius; striking further out glances off).
export const MAX_SPIN_R = 0.50;

// Realistic Russian Pyramid cue speed bounds (700 g cue striking a 285 g ball).
export const V0_MIN = 0.20;
export const V0_MAX = 6.50;

// Empirically simulated travel distances (in 3.56 m table lengths, including
// cushion rebounds on Simonis 950 RusPro tournament cloth) vs. V0 (m/s).
const ROLL_CURVE = [
  [0.2, 0.05],
  [0.4, 0.18],
  [0.8, 0.72],
  [1.0, 0.99],
  [1.3, 1.24],
  [1.6, 1.55],
  [2.0, 1.96],
  [2.5, 2.20],
  [3.0, 2.50],
  [4.0, 3.22],
  [5.0, 3.87],
  [6.5, 4.20],
];

export function v0ToPercent(v0) {
  const clamped = Math.min(V0_MAX, Math.max(V0_MIN, v0));
  return Math.round(1 + ((clamped - V0_MIN) / (V0_MAX - V0_MIN)) * 99);
}

export function percentToV0(pct) {
  const p = Math.min(100, Math.max(1, pct));
  return +(V0_MIN + ((p - 1) / 99) * (V0_MAX - V0_MIN)).toFixed(3);
}

export function v0ToTables(v0) {
  if (v0 <= ROLL_CURVE[0][0]) return ROLL_CURVE[0][1];
  for (let i = 1; i < ROLL_CURVE.length; i++) {
    const [v1, t1] = ROLL_CURVE[i - 1];
    const [v2, t2] = ROLL_CURVE[i];
    if (v0 <= v2) {
      return t1 + ((v0 - v1) / (v2 - v1)) * (t2 - t1);
    }
  }
  return ROLL_CURVE[ROLL_CURVE.length - 1][1];
}

export function shotGrade(pct) {
  if (pct <= 12) return 'Touch';
  if (pct <= 25) return 'Soft';
  if (pct <= 45) return 'Medium';
  if (pct <= 68) return 'Firm';
  if (pct <= 88) return 'Power';
  return 'Break';
}

export function formatShotPower(v0) {
  const pct = v0ToPercent(v0);
  const grade = shotGrade(pct);
  const tables = v0ToTables(v0);
  return `${pct}% · ${grade} (~${tables.toFixed(1)} tables)`;
}

// Spin pad widget (a, b) — y up is topspin (b > 0).
export class SpinPad {
  constructor(canvas, onChange) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.a = 0;
    this.b = 0;
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
      if (r > MAX_SPIN_R) {
        dx = (dx / r) * MAX_SPIN_R;
        dy = (dy / r) * MAX_SPIN_R;
      }
      this.a = dx;
      this.b = dy;
      this.onChange(this.a, this.b);
      this.draw();
    };

    let dragging = false;
    canvas.addEventListener('pointerdown', (e) => { dragging = true; canvas.setPointerCapture(e.pointerId); pos(e); });
    canvas.addEventListener('pointermove', (e) => { if (dragging) pos(e); });
    canvas.addEventListener('pointerup', () => { dragging = false; });
    canvas.addEventListener('dblclick', () => {
      this.set(0, 0);
      this.onChange(0, 0);
    });
  }

  set(a, b) {
    let ca = a, cb = b;
    const r = Math.hypot(ca, cb);
    if (r > MAX_SPIN_R) {
      ca = (ca / r) * MAX_SPIN_R;
      cb = (cb / r) * MAX_SPIN_R;
    }
    this.a = ca;
    this.b = cb;
    this.draw();
  }

  draw() {
    const g = this.g;
    const c = this.canvas.width / 2;
    const r = c - 10;
    const limitR = r * MAX_SPIN_R;
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // full cue ball face
    const grad = g.createRadialGradient(c - r * 0.3, c - r * 0.3, r * 0.1, c, c, r);
    grad.addColorStop(0, '#f6de6b');
    grad.addColorStop(1, '#c8961e');
    g.beginPath();
    g.arc(c, c, r, 0, Math.PI * 2);
    g.fillStyle = grad;
    g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.4)';
    g.lineWidth = 2;
    g.stroke();

    // crosshairs
    g.strokeStyle = 'rgba(0,0,0,0.20)';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(c - r, c); g.lineTo(c + r, c); g.stroke();
    g.beginPath(); g.moveTo(c, c - r); g.lineTo(c, c + r); g.stroke();

    // safe strike zone (miscue limit ring at 50% radius)
    g.setLineDash([4, 3]);
    g.strokeStyle = 'rgba(0,0,0,0.45)';
    g.lineWidth = 1.25;
    g.beginPath();
    g.arc(c, c, limitR, 0, Math.PI * 2);
    g.stroke();
    g.setLineDash([]);

    // tip contact dot
    g.beginPath();
    g.arc(c + this.a * r, c - this.b * r, 6.5, 0, Math.PI * 2);
    g.fillStyle = '#c0392b';
    g.fill();
    g.strokeStyle = '#fff';
    g.lineWidth = 1.5;
    g.stroke();
  }
}
