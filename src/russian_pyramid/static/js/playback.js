// Shot playback: interpolates packed frames, drives trails, ripples, pot
// drops, and the scrubber.  Everything is driven by a sim-time cursor so
// scrubbing backwards is exact.
//
// Pot animation: pooltool teleports a potted ball to the pocket center at
// the capture event, which reads as "the ball disappears".  Instead we
// animate phase A "roll into the hole" from the last free-rolling position
// to the pocket center, then phase B "sink" (3D: drop below the cloth and
// let the cloth occlude it; 2D: shrink and fade).

import { sampleFrames } from './geometry.js';

const ROLL_SPEED = 0.45;   // m/s while rolling into the hole (phase A)
const ROLL_MAX = 0.35;     // s cap
const SINK_TIME = 0.35;    // s to drop below the cloth (phase B)
const SINK_DEPTH = -0.09;  // m, fully under the cloth
const STROKE_TIME = 0.09;  // s of pre-impact cue wind-up + forward stroke
const FOLLOW_TIME = 0.14;  // s of post-impact cue follow-through
const DEFAULT_BALL_R = 0.034;

export class Playback {
  constructor() {
    this.frames = null;      // ball_id -> {t, xyz, w?}
    this.quats = {};         // ball_id -> {t, q: [[qx, qy, qz, qw], ...]}
    this.events = [];
    this.pottedEvents = [];  // [{t, balls}]
    this.duration = 0;
    this.time = 0;
    this.speed = 1;
    this.playing = false;
    this.onEnd = null;
    this._firedIdx = 0;
    this.trailPts = {};
    this.shotCue = null;     // {xy, params, cueBallId} for cue rendering during replay
    this.lastWallTime = 0;
  }

  load(shot) {
    this.events = shot.events || [];
    this.pottedEvents = this.events.filter((e) => e.type === 'pocket');
    this.frames = this._cleanFrames(shot.frames, this.pottedEvents);
    const cueId = shot.cue_ball_id || shot.state?.cue_ball_id || 'cue';
    const startXYZ = this.frames?.[cueId]?.xyz?.[0] || this.frames?.cue?.xyz?.[0] || null;
    const cueParams = shot.attempt?.params || shot.state?.aim || null;
    this.shotCue = (startXYZ && cueParams)
      ? { xy: [startXYZ[0], startXYZ[1]], params: cueParams, cueBallId: cueId }
      : null;
    const lastPotEnd = this.pottedEvents.reduce(
      (m, e) => Math.max(m, e.t + ROLL_MAX + SINK_TIME),
      0,
    );
    this.duration = Math.max(shot.duration || 0, lastPotEnd);
    this.time = -STROKE_TIME;
    this._firedIdx = 0;
    this.trailPts = {};
    this.quats = this._buildQuatFrames(this.frames, this.pottedEvents);
    this.playing = true;
    this.lastWallTime = performance.now();
  }

  // Pullback distance of the cue stick at the current playback time:
  // draws back from the aiming position, accelerates into contact (pull = 0)
  // at t = 0, then smoothly follows through after impact.
  cuePull() {
    const V0 = this.shotCue?.params?.V0 ?? 2.2;
    const pullAim = 0.04 + 0.022 * V0;
    const pullPeak = pullAim * 1.35 + 0.015;
    if (this.time < 0) {
      const u = Math.max(0, Math.min(1, (this.time + STROKE_TIME) / STROKE_TIME));
      if (u < 0.35) {
        const w = u / 0.35;
        return pullAim + (pullPeak - pullAim) * Math.sin(w * Math.PI * 0.5);
      }
      const w = (u - 0.35) / 0.65;
      return pullPeak * (1 - w * w);
    }
    const followMax = Math.min(0.06, 0.015 + 0.008 * V0);
    const v = Math.max(0, Math.min(1, this.time / FOLLOW_TIME));
    const ease = 1 - (1 - v) * (1 - v);
    return -followMax * ease;
  }

  // Strip post-pocket frames where pooltool teleports a potted ball to
  // (pocket.x, pocket.y, -0.08), so interpolation stays on the cloth until
  // our own roll-and-sink animation takes over at pot.t.
  _cleanFrames(rawFrames, pottedEvents) {
    if (!rawFrames) return null;
    const out = {};
    for (const [id, f] of Object.entries(rawFrames)) {
      const pot = pottedEvents.find((e) => e.balls.includes(id));
      if (!pot || !f.t?.length || !f.xyz?.length) {
        out[id] = f;
        continue;
      }
      let cut = f.t.length;
      for (let i = 0; i < f.t.length; i++) {
        const z = f.xyz[i]?.[2] ?? DEFAULT_BALL_R;
        if (z < 0 || f.t[i] > pot.t + 1e-4) {
          cut = Math.max(1, i);
          break;
        }
      }
      out[id] = {
        t: f.t.slice(0, cut),
        xyz: f.xyz.slice(0, cut),
        ...(f.w ? { w: f.w.slice(0, cut) } : {}),
      };
    }
    return out;
  }

  clear() {
    this.frames = null;
    this.quats = {};
    this.playing = false;
    this.trailPts = {};
    this.shotCue = null;
  }

  _buildQuatFrames(frames, pottedEvents) {
    const out = {};
    if (!frames) return out;
    for (const [id, f] of Object.entries(frames)) {
      const ts = f.t || [];
      const pts = f.xyz || [];
      const ws = f.w || null;
      const pot = pottedEvents.find((e) => e.balls.includes(id));
      const potT = pot ? pot.t : Infinity;
      const qs = [];
      let q = [0, 0, 0, 1];
      for (let i = 0; i < ts.length; i++) {
        if (i > 0 && ts[i] <= potT + 1e-5) {
          const dt = Math.max(0, ts[i] - ts[i - 1]);
          let rx = 0, ry = 0, rz = 0;
          if (ws && ws[i] && ws[i - 1] && dt > 0) {
            // pooltool (x, y, z-up) -> world (x, z, y) reflection reverses axial vectors
            const wx = 0.5 * (ws[i - 1][0] + ws[i][0]);
            const wy = 0.5 * (ws[i - 1][1] + ws[i][1]);
            const wz = 0.5 * (ws[i - 1][2] + ws[i][2]);
            rx = -wx * dt;
            ry = -wz * dt;
            rz = -wy * dt;
          } else if (pts[i] && pts[i - 1]) {
            const dx = pts[i][0] - pts[i - 1][0];
            const dy = pts[i][1] - pts[i - 1][1];
            rx = dy / DEFAULT_BALL_R;
            ry = 0;
            rz = -dx / DEFAULT_BALL_R;
          }
          if (rx !== 0 || ry !== 0 || rz !== 0) {
            q = quatMul(quatFromRotVec(rx, ry, rz), q);
          }
        }
        qs.push(q);
      }
      out[id] = { t: ts, q: qs };
    }
    return out;
  }

  seek(t) {
    this.time = Math.max(-STROKE_TIME, Math.min(t, this.duration));
    this._firedIdx = this.events.findIndex((e) => e.t > this.time);
    if (this._firedIdx < 0) this._firedIdx = this.events.length;
    this.rebuildTrails();
  }

  play() {
    if (!this.frames) return;
    if (this.time >= this.duration - 1e-3) {
      this.time = -STROKE_TIME;
      this._firedIdx = 0;
      this.trailPts = {};
    }
    this.playing = true;
    this.lastWallTime = performance.now();
  }

  pause() { this.playing = false; }

  tick() {
    if (!this.playing || !this.frames) return false;
    const now = performance.now();
    const dt = Math.min((now - this.lastWallTime) / 1000, 0.1) * this.speed;
    this.lastWallTime = now;
    this.time += dt;

    while (this._firedIdx < this.events.length &&
           this.events[this._firedIdx].t <= this.time) {
      this._firedIdx++;
    }
    if (this.time >= 0) this.pushTrail();

    if (this.time >= this.duration) {
      this.time = this.duration;
      this.playing = false;
      if (this.onEnd) this.onEnd();
      return false;
    }
    return true;
  }

  positionsAt(t) {
    const out = {};
    for (const [id, f] of Object.entries(this.frames)) {
      out[id] = sampleFrames(f, t);
    }
    return out;
  }

  pushTrail() {
    for (const [id, f] of Object.entries(this.frames)) {
      const pos = sampleFrames(f, this.time);
      if (!pos) continue;
      if (this.isSinking(id)) continue;          // don't trail the drop
      if (!this.trailPts[id]) this.trailPts[id] = [];
      const pts = this.trailPts[id];
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(pos[0] - last[0], pos[1] - last[1]) > 0.004) {
        pts.push(pos);
      }
      while (pts.length > 220) pts.shift();
    }
  }

  isSinking(id) {
    const pot = this.pottedEvents.find((e) => e.balls.includes(id));
    return pot ? this.time > pot.t + ROLL_MAX : false;
  }

  rebuildTrails() {
    this.trailPts = {};
    const t0 = Math.max(0, this.time - 1.1);
    for (const [id, f] of Object.entries(this.frames)) {
      const pts = [];
      for (let t = t0; t <= this.time; t += 1 / 60) {
        const p = sampleFrames(f, t);
        if (p) pts.push(p);
      }
      if (pts.length) this.trailPts[id] = pts;
    }
  }

  // Balls for the renderer at the current time.  pocketById maps id ->
  // {center, radius}; drop2D=true makes sinking shrink+fade (2D top-down)
  // instead of sinking below the cloth (3D).
  // Iterates over `this.frames` (not `ballsStatic`, which comes from the
  // post-shot server state and already omits potted balls).
  visualBalls(ballsStatic, pocketById, drop2D) {
    const positions = this.positionsAt(this.time);
    const staticById = new Map(ballsStatic.map((b) => [b.id, b]));
    const cueId = ballsStatic.find((b) => b.isCue)?.id || 'cue';
    const fallbackR = ballsStatic[0]?.radius || DEFAULT_BALL_R;
    const out = [];
    for (const id of Object.keys(this.frames)) {
      const pos = positions[id];
      if (!pos) continue;
      const base = staticById.get(id) || {
        id,
        isCue: id === cueId,
        radius: fallbackR,
      };
      let xy = [pos[0], pos[1]];
      let z = pos.length > 2 ? pos[2] : fallbackR;
      let scale = 1, alpha = 1, hidden = false;
      const r = base.radius || DEFAULT_BALL_R;
      let quat = sampleQuat(this.quats[id], this.time);

      const pot = this.pottedEvents.find((e) => e.balls.includes(id));
      if (pot) {
        const age = this.time - pot.t;
        if (age < 0) {
          // not yet potted: but pooltool snaps the position at pot.t; if we
          // are before the event the frames are still free-rolling -- fine.
        } else {
          const pocket = nearestPocket(pocketById, xy);
          const from = sampleFrames(this.frames[id], Math.max(0, pot.t - 1e-4)) || xy;
          const dx = pocket[0] - from[0], dy = pocket[1] - from[1];
          const dist = Math.hypot(dx, dy);
          const rollDur = Math.min(ROLL_MAX, dist / ROLL_SPEED);
          if (age < rollDur) {
            // phase A: keep rolling into the hole
            const f = rollDur > 0 ? age / rollDur : 1;
            xy = [from[0] + dx * f, from[1] + dy * f];
            z = from[2] ?? z;
            quat = quatMul(quatFromRotVec((dy * f) / r, 0, -(dx * f) / r), quat);
          } else {
            // phase B: sink
            const f = Math.min(1, (age - rollDur) / SINK_TIME);
            xy = [pocket[0], pocket[1]];
            quat = quatMul(quatFromRotVec(dy / r, 0, -dx / r), quat);
            if (drop2D) {
              scale = 1 - 0.6 * f;
              alpha = 1 - f;
            } else {
              z = (from[2] ?? 0) + (SINK_DEPTH - (from[2] ?? 0)) * f;
            }
            if (f >= 1) hidden = true;
          }
        }
      }
      out.push({ ...base, xy, z, quat, scale, alpha, hidden });
    }
    return out;
  }
}

function quatFromRotVec(rx, ry, rz) {
  const theta = Math.hypot(rx, ry, rz);
  if (theta < 1e-8) return [0, 0, 0, 1];
  const half = theta * 0.5;
  const s = Math.sin(half) / theta;
  return [rx * s, ry * s, rz * s, Math.cos(half)];
}

function quatMul(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  const x = aw * bx + ax * bw + ay * bz - az * by;
  const y = aw * by - ax * bz + ay * bw + az * bx;
  const z = aw * bz + ax * by - ay * bx + az * bw;
  const w = aw * bw - ax * bx - ay * by - az * bz;
  const n = Math.hypot(x, y, z, w) || 1;
  return [x / n, y / n, z / n, w / n];
}

function sampleQuat(qframes, t) {
  if (!qframes || !qframes.t?.length) return [0, 0, 0, 1];
  const { t: ts, q: qs } = qframes;
  const n = ts.length;
  if (t <= ts[0]) return qs[0];
  if (t >= ts[n - 1]) return qs[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) lo = mid; else hi = mid;
  }
  const span = ts[hi] - ts[lo];
  const f = span > 1e-9 ? (t - ts[lo]) / span : 0;
  const a = qs[lo];
  let [bx, by, bz, bw] = qs[hi];
  if (a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw < 0) {
    bx = -bx; by = -by; bz = -bz; bw = -bw;
  }
  const x = a[0] + (bx - a[0]) * f;
  const y = a[1] + (by - a[1]) * f;
  const z = a[2] + (bz - a[2]) * f;
  const w = a[3] + (bw - a[3]) * f;
  const norm = Math.hypot(x, y, z, w) || 1;
  return [x / norm, y / norm, z / norm, w / norm];
}

function nearestPocket(pocketById, pos) {
  let best = null, bestD = Infinity;
  for (const p of Object.values(pocketById)) {
    const d = Math.hypot(p.center[0] - pos[0], p.center[1] - pos[1]);
    if (d < bestD) { bestD = d; best = p.center; }
  }
  return best || pos;
}
