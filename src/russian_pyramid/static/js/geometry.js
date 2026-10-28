// Coordinate transforms between pooltool table space and canvas pixels.
//
// pooltool space: x in [0, w] across the width, y in [0, l] along the length.
// The canvas shows the table landscape: length runs left-to-right, so
// table y -> canvas x, table x -> canvas y.

export class View {
  constructor(table, pad = 0.34) {
    this.table = table;          // {l, w, cushion_width, ...}
    this.pad = pad;              // meters of surround (wood + breathing room)
    this.scale = 1;
    this.ox = 0;
    this.oy = 0;
  }

  resize(cssWidth, cssHeight) {
    const totalL = this.table.l + 2 * this.pad;
    const totalW = this.table.w + 2 * this.pad;
    this.scale = Math.min(cssWidth / totalL, cssHeight / totalW);
    this.ox = (cssWidth - this.table.l * this.scale) / 2;
    this.oy = (cssHeight - this.table.w * this.scale) / 2;
  }

  // table (x, y) -> canvas (px, py)
  cx(x, y) { return this.ox + y * this.scale; }
  cy(x, y) { return this.oy + x * this.scale; }

  // canvas (px, py) -> table (x, y)
  tx(px) { return (px - this.ox) / this.scale; }
  ty(py) { return (py - this.oy) / this.scale; }

  m(v) { return v * this.scale; }  // meters -> pixels
}

export const TAU = Math.PI * 2;

export function deg2rad(d) { return d * Math.PI / 180; }
export function rad2deg(r) { return r * 180 / Math.PI; }

export function normAngleDeg(a) { return ((a % 360) + 360) % 360; }

export function angleDeg(dx, dy) { return normAngleDeg(Math.atan2(dy, dx) * 180 / Math.PI); }

export function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

// Sample {t, xy} frames at time t (binary search + lerp).
export function sampleFrames(frames, t) {
  const { t: ts, xy } = frames;
  const n = ts.length;
  if (n === 0) return null;
  if (t <= ts[0]) return xy[0];
  if (t >= ts[n - 1]) return xy[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) lo = mid; else hi = mid;
  }
  const span = ts[hi] - ts[lo];
  const f = span > 1e-9 ? (t - ts[lo]) / span : 0;
  const a = xy[lo], b = xy[hi];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
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
