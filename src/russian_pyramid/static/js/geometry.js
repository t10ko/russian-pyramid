// Coordinate transforms between pooltool table space and screen space.
//
// pooltool space: x in [0, w] across the width, y in [0, l] along the length,
// z up (ball center height).  Two on-screen layouts:
//   vertical   (default, matches standing at the table): length runs
//              bottom-to-top, y=0 (head) at the bottom of the screen.
//   horizontal : length runs left-to-right (old behavior).

export class View {
  constructor(table, pad = 0.34) {
    this.table = table;          // {l, w, cushion_width, ...}
    this.pad = pad;              // meters of surround (wood + breathing room)
    this.scale = 1;
    this.ox = 0;
    this.oy = 0;
    this.orientation = 'vertical';
  }

  resize(cssWidth, cssHeight) {
    const totalL = this.table.l + 2 * this.pad;
    const totalW = this.table.w + 2 * this.pad;
    this.scale = Math.min(cssWidth / totalL, cssHeight / totalW);
    this.ox = (cssWidth - this.table.l * this.scale) / 2;
    this.oy = (cssHeight - this.table.w * this.scale) / 2;
  }

  // table (x, y) -> canvas (px, py)
  cx(x, y) {
    return this.orientation === 'vertical'
      ? this.ox + x * this.scale
      : this.ox + y * this.scale;
  }

  cy(x, y) {
    return this.orientation === 'vertical'
      ? this.oy + (this.table.l - y) * this.scale   // y grows upward
      : this.oy + x * this.scale;
  }

  // canvas (px, py) -> table (x, y); the horizontal layout swaps axes
  fromCanvas(px, py) {
    if (this.orientation === 'vertical') {
      return [(px - this.ox) / this.scale,
              this.table.l - (py - this.oy) / this.scale];
    }
    return [(py - this.oy) / this.scale, (px - this.ox) / this.scale];
  }

  m(v) { return v * this.scale; }  // meters -> pixels
}

export const TAU = Math.PI * 2;

export function deg2rad(d) { return d * Math.PI / 180; }
export function rad2deg(r) { return r * 180 / Math.PI; }

export function normAngleDeg(a) { return ((a % 360) + 360) % 360; }

export function angleDeg(dx, dy) { return normAngleDeg(Math.atan2(dy, dx) * 180 / Math.PI); }

export function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

// Sample {t, xyz} frames at time t (binary search + per-component lerp).
// Works for any point dimension (2 or 3).
export function sampleFrames(frames, t) {
  const { t: ts, xyz: pts } = frames;
  const n = ts.length;
  if (n === 0) return null;
  if (t <= ts[0]) return pts[0];
  if (t >= ts[n - 1]) return pts[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) lo = mid; else hi = mid;
  }
  const span = ts[hi] - ts[lo];
  const f = span > 1e-9 ? (t - ts[lo]) / span : 0;
  const a = pts[lo], b = pts[hi];
  return a.map((av, i) => av + (b[i] - av) * f);
}

// First contact of a ball (radius r) traveling from `p` along unit `d`
// against another ball at `q` (combined radius cr). Returns distance or null.
export function sweepCircle(p, d, q, cr) {
  const ex = q[0] - p[0], ey = q[1] - p[1];
  const proj = ex * d[0] + ey * d[1];
  if (proj <= 0) return null;
  const distSq = ex * ex + ey * ey - proj * proj;
  const rSq = cr * cr;
  if (distSq >= rSq) return null;
  return proj - Math.sqrt(rSq - distSq);
}
