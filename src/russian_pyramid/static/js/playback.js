// Shot playback: interpolates packed frames, drives trails, ripples, pot
// drops, and the scrubber.  Everything is driven by a sim-time cursor so
// scrubbing backwards is exact.
//
// Pot animation: pooltool captures a ball the instant its center crosses the
// pocket's fall line and teleports it to the pocket center, which reads as
// "the ball disappears".  Instead, each potted ball gets a small physical
// drop simulation seeded with its exact capture position and velocity (sent
// by the server with the pocket event): it rolls to the slate edge, tips over
// it (rolling-over-an-edge dynamics), falls under gravity, slams into the
// leather back of the pocket if it came in hot, and settles in the basket.
// A soft roll-in creeps over the lip and drops almost straight down; a hard
// pot leaves the edge ballistically and hits the back wall within ~20 ms.

import { sampleFrames } from './geometry.js';

const STROKE_TIME = 0.09;  // s of pre-impact cue wind-up + forward stroke
const FOLLOW_TIME = 0.14;  // s of post-impact cue follow-through
const DEFAULT_BALL_R = 0.034;

// --- pot-drop physics -------------------------------------------------------
const G = 9.81;
const DROP_DT = 1 / 600;     // integration step (s)
const DROP_SAMPLE = 4;       // keep every 4th step -> 150 Hz samples
const DROP_MAX_T = 2.5;      // s safety cap
const MIN_LIP_SPEED = 0.10;  // m/s: the cloth bevel (скат) tips even a creeping ball in
const BACK_E = 0.15;         // restitution off the leather apron at the back of the pocket
const APRON_DOWN = 0.25;     // share of impact speed the inclined apron turns downward
const WALL_E = 0.30;         // restitution off the side walls of the throat / basket
const EDGE_E = 0.25;         // restitution off the front face of the hole (slate edge)
const NET_E = 0.18;          // restitution off the net / basket floor
const NET_DAMP = 7.0;        // 1/s horizontal damping while lying in the net
const STACK_RISE = 0.8;      // fraction of R a ball rests higher per ball below it
export class Playback {
  constructor() {
    this.dropSpecs = null;   // pocket id -> pocketDropSpecs() entry (set by main.js)
    this.ballR = DEFAULT_BALL_R;
    this.drops = {};         // ball_id -> precomputed pot-drop trajectory
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
    this.drops = this._buildDrops(this.frames, this.pottedEvents);
    const cueId = shot.cue_ball_id || shot.state?.cue_ball_id || 'cue';
    const startXYZ = this.frames?.[cueId]?.xyz?.[0] || this.frames?.cue?.xyz?.[0] || null;
    const cueParams = shot.attempt?.params || shot.state?.aim || null;
    this.shotCue = (startXYZ && cueParams)
      ? { xy: [startXYZ[0], startXYZ[1]], params: cueParams, cueBallId: cueId }
      : null;
    const lastPotEnd = Object.values(this.drops).reduce(
      (m, d) => Math.max(m, d.t0 + d.settleT + 0.15),
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
    this.drops = {};
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
    const drop = this.drops[id];
    return drop ? this.time > drop.t0 : false;
  }

  // ---------- pot drop -------------------------------------------------------

  _buildDrops(frames, pottedEvents) {
    const out = {};
    if (!frames) return out;
    const perPocket = {};
    for (const e of pottedEvents) {
      for (const id of e.balls) {
        const f = frames[id];
        if (!f?.t?.length) continue;
        const entry = this._entryState(e, f);
        const spec = (e.pocket && this.dropSpecs?.[e.pocket]) ||
          nearestDropSpec(this.dropSpecs, entry.xy);
        const key = spec?.id ?? e.pocket ?? 'pocket';
        const stack = perPocket[key] = (perPocket[key] ?? -1) + 1;
        out[id] = {
          t0: e.t,
          ...simulateDrop(entry, spec, this.ballR || DEFAULT_BALL_R, stack),
        };
      }
    }
    return out;
  }

  // Capture position + velocity: exact values from the server's pocket event,
  // else estimated from the last two free-rolling frames.
  _entryState(e, f) {
    const n = f.t.length;
    const last = f.xyz[n - 1];
    let xy = e.xy ? [e.xy[0], e.xy[1]] : [last[0], last[1]];
    let vel = e.vel ? [e.vel[0], e.vel[1]] : null;
    if (!vel) {
      vel = [0, 0];
      if (n >= 2) {
        const dt = f.t[n - 1] - f.t[n - 2];
        if (dt > 1e-6) {
          vel = [(last[0] - f.xyz[n - 2][0]) / dt, (last[1] - f.xyz[n - 2][1]) / dt];
        }
      }
    }
    return { xy, vel };
  }

  // Pose of a potted ball `age` seconds after capture: {xyz, dq} where dq is
  // the extra rotation accumulated since capture.
  _dropPose(drop, age) {
    const ts = drop.t;
    const n = ts.length;
    if (age >= ts[n - 1]) return { xyz: drop.p[n - 1], dq: drop.q[n - 1] };
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ts[mid] <= age) lo = mid; else hi = mid;
    }
    const span = ts[hi] - ts[lo];
    const f = span > 1e-9 ? (age - ts[lo]) / span : 0;
    const a = drop.p[lo], b = drop.p[hi];
    return {
      xyz: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f],
      dq: f < 0.5 ? drop.q[lo] : drop.q[hi],
    };
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

  // Balls for the renderer at the current time.  drop2D=true makes a potted
  // ball shrink+fade as it falls (2D top-down) instead of dropping below the
  // cloth (3D), where it stays visible lying in the basket.
  // Iterates over `this.frames` (not `ballsStatic`, which comes from the
  // post-shot server state and already omits potted balls).
  visualBalls(ballsStatic, drop2D) {
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

      const drop = this.drops[id];
      if (drop && this.time >= drop.t0) {
        const pose = this._dropPose(drop, this.time - drop.t0);
        xy = [pose.xyz[0], pose.xyz[1]];
        z = pose.xyz[2];
        quat = quatMul(pose.dq, sampleQuat(this.quats[id], drop.t0));
        if (drop2D) {
          // fully gone once the top of the ball is below the cloth
          const f = Math.max(0, Math.min(1, (r - z) / (2 * r)));
          z = r;
          scale = 1 - 0.6 * f;
          alpha = 1 - f;
          if (f >= 1) hidden = true;
        }
      }
      out.push({ ...base, xy, z, quat, scale, alpha, hidden });
    }
    return out;
  }
}

// Drop of a captured ball into its pocket, in the pocket's local frame
// (s along the axis outward, t across, z up from the cloth).
//   roll   -- on the slate until the contact point reaches the fall edge
//   pivot  -- rolls over the edge: (7/5) m R^2 θ'' = m g R sin θ, leaving
//             the edge when the normal force vanishes (R θ'^2 >= g cos θ)
//   fly    -- free fall; dead bounces off the leather back (which also
//             deflects it downward), side walls, the front face of the
//             hole, and the net floor, then settles in the net
// Returns {t: [s], p: [[x, y, z]], q: [quat], settleT}.
function simulateDrop(entry, spec, R, stack = 0) {
  const P = entry.xy;
  const V = entry.vel;
  if (!spec) {
    // no pocket geometry (shouldn't happen): straight drop on the spot
    spec = {
      origin: P, u: unit(V, [1, 0]), v: [-unit(V, [1, 0])[1], unit(V, [1, 0])[0]],
      sLip: 0, sBack: 0.09, halfWidth: R + 0.004, floor: -0.115,
    };
  }
  const { origin: O, u, v } = spec;
  const sBackC = spec.sBack - R;                     // max s of the ball center
  const tMax = Math.max(0.0005, spec.halfWidth - R); // max |t| of the ball center
  const floorZ = spec.floor + R + stack * STACK_RISE * R;
  const kPivot = (5 * G) / (7 * R);

  let s = (P[0] - O[0]) * u[0] + (P[1] - O[1]) * u[1];
  let t = (P[0] - O[0]) * v[0] + (P[1] - O[1]) * v[1];
  let z = R;
  let vs = V[0] * u[0] + V[1] * u[1];
  let vt = V[0] * v[0] + V[1] * v[1];
  let vz = 0;
  if (vs < MIN_LIP_SPEED) vs = MIN_LIP_SPEED;
  const sLip = Math.min(spec.sLip, sBackC - 0.002);
  t = Math.max(-tMax, Math.min(tMax, t));

  let phase = s >= sLip ? 'pivot' : 'roll';
  let theta = 0, thetaDot = vs / R;
  if (phase === 'pivot') {
    // already past the edge at capture: start the pivot from the current lean
    theta = Math.asin(Math.max(0, Math.min(0.95, (s - sLip) / R)));
    z = R * Math.cos(theta);
  }
  // rolling-speed vector (table frame) that drives the visual spin
  let spinS = vs, spinT = vt;
  let q = [0, 0, 0, 1];
  let settled = false, settleT = DROP_MAX_T, restTimer = 0;

  const tsOut = [], pOut = [], qOut = [];
  const emit = (time) => {
    tsOut.push(time);
    pOut.push([
      O[0] + u[0] * s + v[0] * t,
      O[1] + u[1] * s + v[1] * t,
      z,
    ]);
    qOut.push(q);
  };
  emit(0);

  let time = 0;
  for (let step = 1; time < DROP_MAX_T && !settled; step++) {
    const dt = DROP_DT;
    time += dt;

    if (phase === 'roll') {
      s += vs * dt;
      t += vt * dt;
      if (s >= sLip) {
        phase = 'pivot';
        theta = 0;
        thetaDot = vs / R;
      }
    } else if (phase === 'pivot') {
      if (R * thetaDot * thetaDot >= G * Math.cos(theta) || theta > 1.4) {
        // leaves the edge: hand the pivot motion over to free flight
        phase = 'fly';
        vs = R * thetaDot * Math.cos(theta);
        vz = -R * thetaDot * Math.sin(theta);
      } else {
        thetaDot += kPivot * Math.sin(theta) * dt;
        theta += thetaDot * dt;
        s = sLip + R * Math.sin(theta);
        z = R * Math.cos(theta);
        t += vt * dt;
        spinS = R * thetaDot;
      }
    }

    if (phase === 'fly' || phase === 'net') {
      if (phase === 'fly') vz -= G * dt;
      s += vs * dt;
      t += vt * dt;
      z += vz * dt;

      // leather back of the pocket: dead, and its incline sends the ball down
      if (s > sBackC) {
        s = sBackC;
        if (vs > 0) {
          vz -= APRON_DOWN * vs;
          vs = -vs * BACK_E;
          vt *= 0.6;
          spinS *= 0.3; spinT *= 0.5;
        }
      }
      // side walls of the throat / basket
      if (Math.abs(t) > tMax) {
        t = Math.sign(t) * tMax;
        if (vt * t > 0) vt = -vt * WALL_E;
        spinT *= 0.4;
      }
      // front face of the hole: a rebound off the back can't climb out
      if (vs < 0 && s - sLip < R) {
        s = sLip + R;
        vs = -vs * EDGE_E;
        spinS *= 0.5;
      }
      // net / basket floor
      if (z <= floorZ) {
        z = floorZ;
        if (vz < -0.25) {
          vz = -vz * NET_E;
          vs *= 0.55; vt *= 0.55;
          spinS *= 0.5; spinT *= 0.5;
        } else {
          vz = 0;
          phase = 'net';
        }
      }
      if (phase === 'net') {
        const damp = Math.exp(-NET_DAMP * dt);
        vs *= damp; vt *= damp;
        spinS = vs; spinT = vt;
        if (Math.hypot(vs, vt) < 0.01) {
          restTimer += dt;
          if (restTimer > 0.05) { settled = true; settleT = time; }
        }
      }
    } else if (phase === 'roll') {
      spinS = vs; spinT = vt;
    }

    // spin: rolling-speed vector -> world rotation (same mapping as the
    // shot frames: table (x, y) displacement -> rot vec (dy/R, 0, -dx/R))
    const wx = spinS * u[0] + spinT * v[0];
    const wy = spinS * u[1] + spinT * v[1];
    if (wx !== 0 || wy !== 0) {
      q = quatMul(quatFromRotVec((wy * dt) / R, 0, -(wx * dt) / R), q);
    }
    if (step % DROP_SAMPLE === 0 || settled) emit(time);
  }
  if (!settled) settleT = time;
  return { t: tsOut, p: pOut, q: qOut, settleT };
}

function unit(vec, fallback) {
  const n = Math.hypot(vec[0], vec[1]);
  return n > 1e-9 ? [vec[0] / n, vec[1] / n] : fallback;
}

function nearestDropSpec(specs, xy) {
  if (!specs) return null;
  let best = null, bestD = Infinity;
  for (const sp of Object.values(specs)) {
    const d = Math.hypot(sp.origin[0] - xy[0], sp.origin[1] - xy[1]);
    if (d < bestD) { bestD = d; best = sp; }
  }
  return best;
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
