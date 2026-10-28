// Shot playback: interpolates packed frames, drives trails, ripples, pot
// drops, and the scrubber.  Everything is driven by a sim-time cursor so
// scrubbing backwards is exact.

import { sampleFrames } from './geometry.js';

export class Playback {
  constructor() {
    this.frames = null;      // ball_id -> {t, xy}
    this.events = [];
    this.pottedEvents = [];  // [{t, balls}]
    this.duration = 0;
    this.time = 0;
    this.speed = 1;
    this.playing = false;
    this.onEnd = null;
    this._firedIdx = 0;
    this.trailPts = {};
    this.trailWindow = 1.1;  // seconds of trail
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

  // advance by wall clock; returns false when the shot has finished
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

  eventsSince(t) {
    return this.events.filter((e) => e.t > t);
  }

  pushTrail() {
    for (const [id, f] of Object.entries(this.frames)) {
      const pos = sampleFrames(f, this.time);
      if (!pos) continue;
      if (!this.trailPts[id]) this.trailPts[id] = [];
      const pts = this.trailPts[id];
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(pos[0] - last[0], pos[1] - last[1]) > 0.004) {
        pts.push(pos);
      }
      while (pts.length > 220) pts.shift();
    }
  }

  rebuildTrails() {
    this.trailPts = {};
    const t0 = Math.max(0, this.time - this.trailWindow);
    for (const [id, f] of Object.entries(this.frames)) {
      const pts = [];
      for (let t = t0; t <= this.time; t += 1 / 60) {
        const p = sampleFrames(f, t);
        if (p) pts.push(p);
      }
      if (pts.length) this.trailPts[id] = pts;
    }
  }

  // returns balls for the renderer at current time, given static info
  visualBalls(ballsStatic, ripples, pocketById, now) {
    const positions = this.positionsAt(this.time);
    const dropWindow = 0.45;
    const out = [];
    for (const b of ballsStatic) {
      const pos = positions[b.id];
      if (!pos) continue;                    // ball added after this shot
      let scale = 1, alpha = 1, hidden = false, xy = pos;

      const pot = this.pottedEvents.find((e) => e.balls.includes(b.id));
      if (pot) {
        const age = this.time - pot.t;
        if (age < 0) { /* not yet potted */ }
        else if (age < dropWindow) {
          const f = age / dropWindow;
          const pocket = nearestPocket(pocketById, pot, b.id, this);
          xy = [pos[0] + (pocket[0] - pos[0]) * f, pos[1] + (pocket[1] - pos[1]) * f];
          scale = 1 - 0.7 * f;
          alpha = 1 - f;
        } else {
          hidden = true;
        }
        if (age >= 0 && age < 0.05 && !b._pottedFired) {
          // caller reads ripples via events; nothing to do here
        }
      }
      out.push({ ...b, xy, scale, alpha, hidden });
    }
    return out;
  }
}

function nearestPocket(pocketById, potEvent, ballId, playback) {
  // find where the ball was at pot time; nearest pocket center wins
  const pos = playback.positionsAt(potEvent.t)[ballId] || [0, 0];
  let best = null, bestD = Infinity;
  for (const p of Object.values(pocketById)) {
    const d = Math.hypot(p.center[0] - pos[0], p.center[1] - pos[1]);
    if (d < bestD) { bestD = d; best = p.center; }
  }
  return best || pos;
}
