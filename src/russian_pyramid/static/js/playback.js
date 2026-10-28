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

export class Playback {
  constructor() {
    this.frames = null;      // ball_id -> {t, xyz}
    this.events = [];
    this.pottedEvents = [];  // [{t, balls}]
    this.duration = 0;
    this.time = 0;
    this.speed = 1;
    this.playing = false;
    this.onEnd = null;
    this._firedIdx = 0;
    this.trailPts = {};
    this.lastWallTime = 0;
  }

  load(shot) {
    this.frames = shot.frames;
    this.events = shot.events || [];
    this.pottedEvents = this.events.filter((e) => e.type === 'pocket');
    this.duration = shot.duration || 0;
    this.time = 0;
    this._firedIdx = 0;
    this.trailPts = {};
    this.playing = true;
    this.lastWallTime = performance.now();
  }

  clear() {
    this.frames = null;
    this.playing = false;
    this.trailPts = {};
  }

  seek(t) {
    this.time = Math.max(0, Math.min(t, this.duration));
    this._firedIdx = this.events.findIndex((e) => e.t > this.time);
    if (this._firedIdx < 0) this._firedIdx = this.events.length;
    this.rebuildTrails();
  }

  play() {
    if (!this.frames) return;
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
    this.pushTrail();

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
  visualBalls(ballsStatic, pocketById, drop2D) {
    const positions = this.positionsAt(this.time);
    const out = [];
    for (const b of ballsStatic) {
      const pos = positions[b.id];
      if (!pos) continue;                    // ball not in this shot
      let xy = [pos[0], pos[1]];
      let z = pos.length > 2 ? pos[2] : 0;
      let scale = 1, alpha = 1, hidden = false;

      const pot = this.pottedEvents.find((e) => e.balls.includes(b.id));
      if (pot) {
        const age = this.time - pot.t;
        if (age < 0) {
          // not yet potted: but pooltool snaps the position at pot.t; if we
          // are before the event the frames are still free-rolling -- fine.
        } else {
          const pocket = nearestPocket(pocketById, xy);
          const from = sampleFrames(this.frames[b.id], Math.max(0, pot.t - 1e-4)) || xy;
          const dx = pocket[0] - from[0], dy = pocket[1] - from[1];
          const dist = Math.hypot(dx, dy);
          const rollDur = Math.min(ROLL_MAX, dist / ROLL_SPEED);
          if (age < rollDur) {
            // phase A: keep rolling into the hole
            const f = rollDur > 0 ? age / rollDur : 1;
            xy = [from[0] + dx * f, from[1] + dy * f];
            z = from[2] ?? z;
          } else {
            // phase B: sink
            const f = Math.min(1, (age - rollDur) / SINK_TIME);
            xy = [pocket[0], pocket[1]];
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
      out.push({ ...b, xy, z, scale, alpha, hidden });
    }
    return out;
  }
}

function nearestPocket(pocketById, pos) {
  let best = null, bestD = Infinity;
  for (const p of Object.values(pocketById)) {
    const d = Math.hypot(p.center[0] - pos[0], p.center[1] - pos[1]);
    if (d < bestD) { bestD = d; best = p.center; }
  }
  return best || pos;
}
