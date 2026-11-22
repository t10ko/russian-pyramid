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
// Pass `inclusive = true` when testing a sightline ray against a single ball
// radius so exact edge/tangent hits (30° half-ball cut) still register.
export function sweepCircle(p, d, q, cr, inclusive = false) {
  const ex = q[0] - p[0], ey = q[1] - p[1];
  const proj = ex * d[0] + ey * d[1];
  if (proj <= 0) return null;
  const distSq = ex * ex + ey * ey - proj * proj;
  const rSq = cr * cr;
  if (inclusive ? distSq > rSq + 1e-12 : distSq >= rSq) return null;
  return proj - Math.sqrt(Math.max(0, rSq - distSq));
}

// ---------- pocket geometry (shared by the 3D table and the pot-drop animation)

// Visual mouth parameters matching the pooltool specs in config.py.
export const POCKET_DIMS = {
  cNose: 0.05127,   // corner: 72.5 mm throat / sqrt(2) along each rail
  sNose: 0.0398,    // side: nose vertex half-width at the rail line
  sBack: 0.0446,    // side: jaw half-width at the back of the cushion (5° splay)
};
export const POCKET_WELL_DEPTH = 0.115;   // m from the cloth to the basket floor

// Descriptor for each of the 6 Russian Pyramid pockets in its local (s, t)
// coordinate frame: origin at the corner / rail midpoint, `u` pointing outward
// into the pocket, `v` across the mouth (90° CCW from `u`).
export function buildPocketSpecs(w, l, cw, cNose, cBack, sNose, sBack) {
  const s2 = Math.SQRT1_2;
  const cornerIn = -cNose * s2 + 0.006;         // -0.0302 m (inside rounded jaw horn line)
  const cornerOut = (2 * cw - cNose) * s2;      // +0.0415 m (outer jaw end at cw)
  const cornerHalf = cNose * s2;                //  0.03625 m (half of 72.5 mm corner throat)
  const corners = [
    { id: 'lb', origin: [0, 0], u: [-s2, -s2] },
    { id: 'lt', origin: [0, l], u: [-s2, s2] },
    { id: 'rb', origin: [w, 0], u: [s2, -s2] },
    { id: 'rt', origin: [w, l], u: [s2, s2] },
  ].map((c) => ({
    ...c,
    corner: true,
    v: [-c.u[1], c.u[0]],
    sIn: cornerIn,
    sLip: cornerIn + 0.003,     // fall edge (скат лузы) at the end of the 5.5 mm corridor
    sOut: cornerOut,
    halfMouth: cornerHalf,
    halfBack: cornerHalf,
    sWell: cornerOut + 0.007,   // circular drop basket center behind the jaws
    rWell: 0.039,               // 78 mm basket diameter (snug behind 72.5 mm throat)
  }));

  const sides = [
    { id: 'lc', origin: [0, l / 2], u: [-1, 0] },
    { id: 'rc', origin: [w, l / 2], u: [1, 0] },
  ].map((s) => ({
    ...s,
    corner: false,
    v: [-s.u[1], s.u[0]],
    sIn: 0.005,
    sLip: -0.015,               // fall edge ~5 mm in front of the nose line (physics)
    sOut: cw * 0.78,
    halfMouth: 0.041,           // half of 82.0 mm side pocket mouth
    halfBack: sBack,
    sWell: cw * 0.82,
    rWell: 0.043,               // 86 mm basket diameter behind 82.0 mm side mouth
  }));

  return [...corners, ...sides];
}


// Per-pocket frame for the pot-drop animation, in table (x, y) metres:
// `origin` + s * `u` (outward along the pocket axis) + t * `v` (across).
//   sLip      axis position of the slate fall edge (ball tips over here)
//   sBack     back wall of the basket (leather apron / net)
//   halfWidth half-width the ball can move across while dropping
//   floor     basket floor height (table z, negative = below the cloth)
export function pocketDropSpecs(table) {
  const { cNose, sNose, sBack } = POCKET_DIMS;
  const cw = table.cushion_width;
  const specs = buildPocketSpecs(table.w, table.l, cw, cNose, cNose - cw, sNose, sBack);
  const out = {};
  for (const ps of specs) {
    out[ps.id] = {
      id: ps.id,
      corner: ps.corner,
      origin: ps.origin,
      u: ps.u,
      v: ps.v,
      sLip: 0.5 * (ps.sIn + ps.sLip),
      sBack: ps.sWell + ps.rWell,
      halfWidth: Math.min(ps.halfMouth, ps.rWell),
      floor: -POCKET_WELL_DEPTH,
    };
  }
  return out;
}
