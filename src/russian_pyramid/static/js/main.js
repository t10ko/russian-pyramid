// Application controller: owns the server state, wires UI + canvas together.

import { api } from './api.js';
import { View } from './geometry.js';
import { Renderer } from './render.js';
import { Aim, SpinPad } from './aim.js';
import { Playback } from './playback.js';
import { Interact } from './interact.js';
import { $, hideBanner, renderAttempts, setHint, showBanner, toast, updateStats } from './ui.js';

class App {
  constructor() {
    this.state = null;
    this.view = null;
    this.renderer = new Renderer($('table'));
    this.playback = new Playback();
    this.mode = 'aim';
    this.assistPaths = null;
    this.ripples = [];
    this.pocketFlashes = [];
    this.dragPreview = null;
    this.attemptShots = new Map();   // n -> shot payload (client-side replay cache)
    this._firedEvents = 0;
    this._predictTimer = null;
    this._aimSyncTimer = null;
    this.busy = false;
  }

  get ballRadius() { return this.state.ball_radius; }
  get table() { return this.state.table; }

  pocketById() {
    const map = {};
    for (const p of this.table.pockets) map[p.id] = p;
    return map;
  }

  staticBalls() {
    const balls = this.state.balls.map((b) => ({
      id: b.id, xy: b.xy, isCue: b.is_cue, radius: this.ballRadius,
    }));
    if (this.dragPreview) {
      const b = balls.find((x) => x.id === this.dragPreview.id);
      if (b) b.xy = this.dragPreview.xy;
    }
    return balls;
  }

  hasCue() { return this.state.cue_on_table; }
  cueXY() { return this.state.balls.find((b) => b.is_cue)?.xy || [0, 0]; }
  nearCue(xy) {
    const c = this.cueXY();
    return Math.hypot(c[0] - xy[0], c[1] - xy[1]) < this.ballRadius * 2.2;
  }

  // ---------- boot ----------

  async init() {
    this.state = await api.state();
    this.view = new View(this.table);
    this.aim = new Aim(this.table, this.ballRadius);
    this.aim.phi = this.state.aim.phi;
    this.aim.V0 = this.state.aim.V0;

    this.spinPad = new SpinPad($('spin-pad'), (a, b) => this.setAim({ a, b }));
    this.spinPad.set(this.state.aim.a, this.state.aim.b);

    new Interact($('table'), this);
    this.wireUI();

    const ro = new ResizeObserver(() => this.renderer.resize(this.view));
    ro.observe($('table-wrap'));
    this.renderer.resize(this.view);

    this.playback.onEnd = () => this.onShotEnd();
    this.refreshUI();
    setHint('drag to aim · space to shoot · R repeats the same situation');

    requestAnimationFrame((t) => this.frame(t));
  }

  // ---------- UI wiring ----------

  wireUI() {
    const drillSel = $('drill-select');
    for (const d of this.state.drills) {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.label;
      drillSel.appendChild(opt);
    }
    drillSel.value = this.state.drill;
    drillSel.addEventListener('change', async () => {
      try {
        this.state = await api.setDrill(drillSel.value);
        this.afterSituationChange(`drill: ${this.state.drill}`);
      } catch (err) { toast(err.message, 'error'); }
    });

    const physSel = $('physics-select');
    for (const [name] of Object.entries(this.state.physics_presets)) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      physSel.appendChild(opt);
    }
    physSel.value = this.state.physics_preset;
    physSel.addEventListener('change', async () => {
      try {
        this.state = await api.setPhysics(physSel.value);
        this.afterSituationChange(`cushions: ${physSel.value}`);
      } catch (err) { toast(err.message, 'error'); }
    });

    $('mode-toggle').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (btn) this.setMode(btn.dataset.mode);
    });

    $('btn-shoot').addEventListener('click', () => this.shoot());
    $('btn-repeat').addEventListener('click', () => this.repeatSituation());
    $('btn-undo').addEventListener('click', () => this.repeatSituation());
    $('btn-help').addEventListener('click', () => this.showHelp());
    $('help-close').addEventListener('click', () => $('help').close());
    $('help').addEventListener('click', (e) => { if (e.target === $('help')) $('help').close(); });

    $('power').addEventListener('input', (e) => this.setAim({ V0: +e.target.value }));
    $('theta').addEventListener('input', (e) => this.setAim({ theta: +e.target.value }));

    $('assist').addEventListener('change', (e) => {
      if (e.target.checked) this.schedulePredict();
      else this.assistPaths = null;
    });
    $('trails').addEventListener('change', (e) => { /* read live in buildScene */ });
    $('ghost').addEventListener('change', (e) => { /* read live in buildScene */ });

    $('pl-play').addEventListener('click', () => {
      if (this.playback.playing) this.playback.pause();
      else this.playback.play();
      this.syncPlayButton();
    });
    $('pl-speed').addEventListener('change', (e) => {
      this.playback.speed = +e.target.value;
    });
    $('pl-scrub').addEventListener('input', (e) => {
      if (!this.playback.frames) return;
      this.playback.pause();
      this.playback.seek(+e.target.value);
      this._firedEvents = 0;
      this.ripples = [];
      this.pocketFlashes = [];
    });
    $('pl-scrub').addEventListener('pointerdown', () => { this._scrubbing = true; });
    $('pl-scrub').addEventListener('pointerup', () => { this._scrubbing = false; });
    this._scrubbing = false;

    document.querySelectorAll('.spin-presets button').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.setAim({ a: +btn.dataset.a, b: +btn.dataset.b });
        this.spinPad.set(+btn.dataset.a, +btn.dataset.b);
      });
    });
  }

  refreshUI() {
    $('power').value = this.aim.V0;
    $('theta').value = this.aim.theta;
    $('v0-read').textContent = `${this.aim.V0.toFixed(2)} m/s`;
    $('theta-read').textContent = `${this.aim.theta}°`;
    $('phi-read').textContent = `${this.aim.phi.toFixed(2)}°`;
    updateStats(this.state);
    renderAttempts(this.state, (n) => this.replayAttempt(n));
    $('btn-repeat').disabled = $('btn-undo').disabled = !this.state.can_undo;
    this.syncPlayButton();
  }

  syncPlayButton() {
    $('pl-play').textContent = this.playback.playing ? '❚❚' : '▶';
  }

  // ---------- aim ----------

  setAim(patch) {
    Object.assign(this.aim, patch);
    if (patch.a !== undefined || patch.b !== undefined) {
      this.spinPad.set(this.aim.a, this.aim.b);
    }
    this.refreshUI();
    clearTimeout(this._aimSyncTimer);
    this._aimSyncTimer = setTimeout(() => api.aim(this.aim.params()).catch(() => {}), 250);
    this.schedulePredict();
  }

  nudgeAim(d) { this.setAim({ phi: (this.aim.phi + d + 360) % 360 }); }
  nudgePower(d) {
    this.setAim({ V0: Math.min(10, Math.max(0.2, +(this.aim.V0 + d).toFixed(2))) });
  }

  aimAtBall(ball, exact = false) {
    const cue = this.cueXY();
    // default: aim so the object ball is thrown along the cue->ball line
    const phi = Math.atan2(ball.xy[1] - cue[1], ball.xy[0] - cue[0]) * 180 / Math.PI;
    this.setAim({ phi: (phi + 360) % 360 });
    if (exact) toast('aimed at ball ' + ball.id);
  }

  schedulePredict() {
    if (!$('assist').checked || !this.hasCue() || this.playback.frames) return;
    clearTimeout(this._predictTimer);
    this._predictTimer = setTimeout(async () => {
      try {
        const res = await api.predict(this.aim.params());
        this.assistPaths = res.paths;
      } catch { /* transient */ }
    }, 160);
  }

  // ---------- shooting ----------

  async shoot() {
    if (this.busy) return;
    if (!this.hasCue()) { toast('the cue ball is in the pocket — respawn it first', 'error'); return; }
    this.busy = true;
    hideBanner();
    try {
      const payload = await api.shoot(this.aim.params());
      this.applyShot(payload);
    } catch (err) {
      toast(err.message, 'error', 4000);
    } finally {
      this.busy = false;
    }
  }

  applyShot(payload) {
    this.state = payload.state;
    this.attemptShots.set(payload.attempt.n, payload);
    if (this.attemptShots.size > 40) {
      this.attemptShots.delete(this.attemptShots.keys().next().value);
    }
    this.assistPaths = null;
    this.ripples = [];
    this.pocketFlashes = [];
    this._firedEvents = 0;
    this.playback.load(payload);
    this.refreshUI();
    this.syncPlayButton();
  }

  onShotEnd() {
    const { potted, cue_potted, attempt } = this.lastShotInfo();
    this.syncPlayButton();
    const buttons = [
      { label: '↺ Repeat (R)', accent: true, onClick: () => this.repeatSituation() },
      { label: 'Keep position', onClick: () => hideBanner() },
    ];
    if (cue_potted) {
      buttons.push({
        label: 'Respawn cue',
        onClick: async () => {
          this.state = await api.respawnCue();
          this.playback.clear();
          this.afterSituationChange('cue ball respawned');
        },
      });
      showBanner('bad', 'Scratch — cue ball potted',
        `${potted.length ? `potted ${potted.join(', ')} before dropping in` : 'the cue ball went in'}`,
        buttons);
    } else if (potted.length) {
      showBanner('good', `Potted ${potted.join(', ')}`,
        `attempt #${attempt.n} · ${attempt.cushion_hits} cushion hits · ${attempt.duration.toFixed(1)} s`,
        buttons);
    } else {
      showBanner('bad', 'Missed',
        `attempt #${attempt.n} · ${attempt.cushion_hits} cushion hits — same ball, same angle, again`,
        buttons);
    }
    if ($('assist').checked) this.schedulePredict();
  }

  lastShotInfo() {
    const payload = [...this.attemptShots.values()].pop();
    if (payload) {
      return { potted: payload.potted, cue_potted: payload.cue_potted, attempt: payload.attempt };
    }
    return { potted: [], cue_potted: false, attempt: { n: 0, cushion_hits: 0, duration: 0 } };
  }

  // ---------- situation management ----------

  async repeatSituation() {
    if (!this.state.can_undo) { toast('nothing to repeat yet'); return; }
    try {
      this.state = await api.undo();
      this.afterSituationChange('situation restored — same ball, same angle');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  afterSituationChange(msg) {
    this.playback.clear();
    this.assistPaths = null;
    hideBanner();
    Object.assign(this.aim, this.state.aim);
    this.spinPad.set(this.aim.a, this.aim.b);
    this.refreshUI();
    if (msg) toast(msg);
    if ($('assist').checked) this.schedulePredict();
  }

  replayLast() { this.replayAttempt(Math.max(...this.attemptShots.keys(), 0)); }

  replayAttempt(n) {
    const payload = this.attemptShots.get(n);
    if (!payload) { toast('attempt frames are gone (page was reloaded)'); return; }
    hideBanner();
    this.ripples = [];
    this.pocketFlashes = [];
    this._firedEvents = 0;
    this.playback.load(payload);
    this.playback.pause();
    this.playback.seek(0);
    this.playback.play();
    this.syncPlayButton();
  }

  // ---------- ball editing ----------

  onDragPreview(preview) {
    this.dragPreview = preview ? { id: preview.id, xy: preview.xy } : null;
  }

  async moveBall(id, xy) {
    try {
      this.state = await api.moveBall(id, xy);
      this.afterSituationChange(null);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async addBall(xy) {
    try {
      const res = await api.addBall(xy);
      this.state = res.state;
      this.afterSituationChange(`added ball ${res.id}`);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async removeBall(id) {
    try {
      this.state = await api.removeBall(id);
      this.afterSituationChange(`removed ball ${id}`);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // ---------- modes ----------

  setMode(mode) {
    this.mode = mode;
    for (const btn of $('mode-toggle').querySelectorAll('button')) {
      btn.classList.toggle('on', btn.dataset.mode === mode);
    }
    $('table').style.cursor = mode === 'place' ? 'move' : 'crosshair';
    setHint(mode === 'place'
      ? 'drag balls to move · click cloth to add · right-click to remove · M to aim'
      : 'drag to aim · space to shoot · R repeats the same situation');
  }

  toggleMode() { this.setMode(this.mode === 'aim' ? 'place' : 'aim'); }
  toggleAssist() { $('assist').checked = !$('assist').checked; $('assist').dispatchEvent(new Event('change')); }
  showHelp() { $('help').showModal(); }

  // ---------- render loop ----------

  fireEvents() {
    if (!this.playback.frames) return;
    const evs = this.playback.events;
    while (this._firedEvents < evs.length &&
           evs[this._firedEvents].t <= this.playback.time + 1e-6) {
      const e = evs[this._firedEvents++];
      const now = performance.now() / 1000;
      if (e.type === 'pocket') {
        const pos = this.playback.positionsAt(e.t);
        for (const id of e.balls) {
          const p = pos[id];
          if (p) this.pocketFlashes.push({ xy: nearestPocketCenter(p, this), t0: now });
        }
      } else {
        const pos = this.playback.positionsAt(e.t);
        for (const id of e.balls) {
          const p = pos[id];
          if (p) this.ripples.push({ xy: p, t0: now, kind: e.type });
        }
      }
    }
    // trim finished effects
    const now = performance.now() / 1000;
    this.ripples = this.ripples.filter((r) => now - r.t0 < 0.7);
    this.pocketFlashes = this.pocketFlashes.filter((f) => now - f.t0 < 0.8);
  }

  buildScene() {
    const playing = this.playback.frames &&
      (this.playback.playing || this.playback.time < this.playback.duration - 1e-3);
    let balls;
    if (this.playback.frames && !this.dragPreview) {
      balls = this.playback.visualBalls(this.staticBalls(), null,
        this.pocketById(), performance.now() / 1000);
    } else {
      balls = this.staticBalls();
    }
    const cue = balls.find((b) => b.isCue && !b.hidden);
    return {
      balls,
      playing,
      aim: (cue && !playing && this.mode === 'aim')
        ? { ...this.aim.preview(cue.xy, this.staticBalls()),
            ...this.aim.params(),
            showGhost: $('ghost').checked,
            showSpin: true }
        : null,
      assist: (!playing && this.assistPaths) ? this.assistPaths : null,
      trails: this.playback.trailPts,
      trailsOn: $('trails').checked && !!this.playback.frames,
      ripples: this.ripples,
      pocketFlashes: this.pocketFlashes,
      now: performance.now() / 1000,
    };
  }

  frame() {
    this.playback.tick();
    this.fireEvents();
    this.renderer.draw(this.buildScene(), this.view);

    if (this.playback.frames) {
      $('pl-scrub').disabled = false;
      if (!this._scrubbing) {
        $('pl-scrub').value = this.playback.time;
        $('pl-scrub').max = this.playback.duration || 1;
        $('pl-time').textContent =
          `${this.playback.time.toFixed(1)} / ${this.playback.duration.toFixed(1)} s`;
      }
    }
    requestAnimationFrame(() => this.frame());
  }
}

function nearestPocketCenter(p, app) {
  let best = null, bestD = Infinity;
  for (const pk of app.table.pockets) {
    const d = Math.hypot(pk.center[0] - p[0], pk.center[1] - p[1]);
    if (d < bestD) { bestD = d; best = pk.center; }
  }
  return best || p;
}

const app = new App();
app.init().catch((err) => {
  document.body.insertAdjacentHTML('afterbegin',
    `<div style="color:#e5544b;padding:20px;font-family:monospace">failed to start: ${err}</div>`);
});
