// Application controller: owns the server state, wires UI + 3D canvas.
//
// This is a 3D-only test ground.  The 2D canvas renderer still exists in
// render.js but is reachable only through the __RP_FORCE_2D__ flag used by
// scripts/ui_smoke.mjs (Node has no WebGL); browsers always render in 3D.

import { api } from './api.js';
import { View, pocketDropSpecs } from './geometry.js';
import { Renderer } from './render.js';
import { Renderer3D } from './render3d.js';
import { Aim, SpinPad, MAX_SPIN_R, V0_MIN, V0_MAX, v0ToPercent, percentToV0, formatShotPower } from './aim.js';
import { Playback } from './playback.js';
import { Interact } from './interact.js';
import { $, hideBanner, renderAttempts, setHint, showBanner, toast, updateStats } from './ui.js';

class App {
  constructor() {
    this.state = null;
    this.view = null;
    this.playback = new Playback();
    this.mode = 'aim';
    this.ripples = [];
    this.pocketFlashes = [];
    this.dragPreview = null;
    this.attemptShots = new Map();   // n -> shot payload (client-side replay cache)
    this.activeAttemptN = null;      // currently selected/last attempt for playback
    this._savedLiveAim = null;       // live aim snapshot while in playback mode
    this._firedEvents = 0;
    this._aimSyncTimer = null;
    this.busy = false;
    this.shiftHeld = false;
    this.focusBallId = 'cue';
    this.cueBallId = 'cue';
    this._framed = false;

    // Physics aim preview (first ball actually touched, its path, the cue
    // ball's path).  Toggles: T = target-ball path, Y = cue-ball path.
    this.showTargetPath = loadPref('rp.targetPath', false);
    this.showCuePath = loadPref('rp.cuePath', true);
    this.pred = null;                // last server prediction {key, layoutKey, ...}
    this._predWantKey = null;        // key of the current aim/layout
    this._predSentKey = null;        // key of the last request sent
    this._predInflight = false;

    // headless-test path only; browsers are always 3D
    this.viewMode = globalThis.__RP_FORCE_2D__ ? '2d' : '3d';
    this.r2d = globalThis.__RP_FORCE_2D__ ? new Renderer($('table')) : null;
    this.r3d = null;
  }

  get renderer() {
    return this.viewMode === '3d' ? this.r3d : this.r2d;
  }

  activeCanvas() {
    return $('table3d');
  }

  get ballRadius() { return this.state.ball_radius; }
  get table() { return this.state.table; }

  // Some endpoints return state without the (immutable) table geometry --
  // never let those responses wipe it.
  applyState(next) {
    if (this.state?.table && !next.table) next.table = this.state.table;
    this.state = next;
    if (next.cue_ball_id) {
      this.cueBallId = next.cue_ball_id;
      this.focusBallId = next.cue_ball_id;
    }
  }

  clearAttemptHistory() {
    this.attemptShots.clear();
    this.activeAttemptN = null;
  }

  hasReplay() {
    return this.attemptShots.size > 0;
  }

  latestAttemptN() {
    return this.attemptShots.size ? Math.max(...this.attemptShots.keys()) : 0;
  }

  isLiveShotRolling() {
    return this.mode !== 'playback' && !!this.playback.frames &&
      (this.playback.playing || this._scrubbing || this.playback.time < this.playback.duration - 1e-3);
  }

  staticBalls() {
    const balls = this.state.balls.map((b) => ({
      id: b.id,
      xy: b.xy,
      z: this.ballRadius,
      isCue: b.id === this.cueBallId,
      radius: this.ballRadius,
    }));
    if (this.dragPreview) {
      const b = balls.find((x) => x.id === this.dragPreview.id);
      if (b) b.xy = this.dragPreview.xy;
    }
    return balls;
  }

  hasCue() { return this.state.balls.some((b) => b.id === this.cueBallId); }
  cueXY() { return this.state.balls.find((b) => b.id === this.cueBallId)?.xy || [0, 0]; }
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
    this.playback.dropSpecs = pocketDropSpecs(this.table);
    this.playback.ballR = this.ballRadius;

    this.spinPad = new SpinPad($('spin-pad'), (a, b) => this.setAim({ a, b }));
    this.spinPad.set(this.state.aim.a, this.state.aim.b);

    this.interact = new Interact($('table-wrap'), this);
    this._lastFrameTime = performance.now();
    this.wireUI();

    window.addEventListener('keydown', (e) => { if (e.key === 'Shift') this.setShift(true); });
    window.addEventListener('keyup', (e) => { if (e.key === 'Shift') this.setShift(false); });
    window.addEventListener('blur', () => this.setShift(false));

    if (this.viewMode === '3d') this.ensure3d();

    const ro = new ResizeObserver(() => this.onResize());
    ro.observe($('table-wrap'));
    this.onResize();

    this.playback.onEnd = () => this.onShotEnd();
    this.refreshUI();
    this.updateControls();
    this.syncModeButtons();

    if (typeof location !== 'undefined') {
      const params = new URLSearchParams(location.search);
      if (params.has('drill')) {
        api.setDrill(params.get('drill')).then((next) => {
          this.applyState(next);
          this.refreshUI();
          if (params.has('follow')) this.setFocusBall(params.get('follow'));
          if (params.has('cam')) this.setCameraPreset(params.get('cam'));
          if (params.has('help')) this.showHelp();
        }).catch(() => {});
      } else {
        if (params.has('follow')) setTimeout(() => this.setFocusBall(params.get('follow')), 100);
        if (params.has('cam')) setTimeout(() => this.setCameraPreset(params.get('cam')), 100);
        if (params.has('help')) setTimeout(() => this.showHelp(), 100);
      }
      if (params.has('autoshot')) {
        setTimeout(() => this.shoot(), 1500);   // debug hook for screenshots
      }
    }
    this.initDone = true;
    this.frame();   // paint immediately; frame() re-registers via rAF
  }

  onResize() {
    this.r2d?.resize(this.view);
    if (this.r3d) this.r3d.resize();
  }

  ensure3d() {
    if (!this.r3d) {
      try {
        this.r3d = new Renderer3D($('table3d'), this.table, this.ballRadius);
        this.r3d.setCamera(this.cameraPreset || 'tv');
        this.r3d.resize();
      } catch (err) {
        console.error('3D renderer failed:', err);
        toast(`3D view unavailable (${err.message})`, 'error', 6000);
      }
    }
    return this.r3d;
  }

  // ---------- UI wiring ----------

  wireUI() {
    $('camera-toggle').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (btn) this.setCameraPreset(btn.dataset.cam);
    });
    $('mode-toggle').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (btn) this.setMode(btn.dataset.mode);
    });

    $('btn-shoot').addEventListener('click', () => this.shoot());
    $('btn-rack').addEventListener('click', () => this.startFullRack());
    $('btn-focus-cue').addEventListener('click', () => this.focusCueBall({ alignAim: true }));
    $('btn-repeat').addEventListener('click', () => this.repeatSituation());
    $('btn-undo').addEventListener('click', () => this.repeatSituation());
    $('btn-help').addEventListener('click', () => this.showHelp());
    $('help-close').addEventListener('click', () => $('help').close());
    $('help').addEventListener('click', (e) => { if (e.target === $('help')) $('help').close(); });

    $('power').addEventListener('input', (e) => this.setAim({ V0: percentToV0(+e.target.value) }));
    $('theta').addEventListener('input', (e) => this.setAim({ theta: +e.target.value }));

    $('pl-play').addEventListener('click', () => this.togglePlayback());
    $('pl-speed').addEventListener('change', (e) => {
      this.playback.speed = +e.target.value;
    });
    $('pl-scrub').addEventListener('input', (e) => {
      if (!this.hasReplay()) return;
      if (this.mode !== 'playback' || !this.playback.frames) {
        const n = (this.activeAttemptN && this.attemptShots.has(this.activeAttemptN))
          ? this.activeAttemptN
          : this.latestAttemptN();
        if (!this.enterPlaybackForAttempt(n, { autoPlay: false })) return;
      }
      this.playback.pause();
      this.playback.seek(+e.target.value);
      this._firedEvents = 0;
      this.ripples = [];
      this.pocketFlashes = [];
      this.syncPlayButton();
      const displayTime = Math.max(0, this.playback.time);
      $('pl-time').textContent =
        `${displayTime.toFixed(1)} / ${this.playback.duration.toFixed(1)} s`;
    });
    $('pl-scrub').addEventListener('pointerdown', () => { this._scrubbing = true; });
    $('pl-scrub').addEventListener('pointerup', () => { this._scrubbing = false; });
    window.addEventListener('pointerup', () => { this._scrubbing = false; });
    window.addEventListener('pointercancel', () => { this._scrubbing = false; });
    this._scrubbing = false;

    document.querySelectorAll('.spin-presets button').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.setAim({ a: +btn.dataset.a, b: +btn.dataset.b });
      });
    });

    $('target-path').checked = this.showTargetPath;
    $('target-path').addEventListener('change', (e) => this.setTargetPath(e.target.checked));
    $('cue-path').checked = this.showCuePath;
    $('cue-path').addEventListener('change', (e) => this.setCuePath(e.target.checked));
  }

  // ---------- physics aim preview ----------

  setTargetPath(on) {
    this.showTargetPath = !!on;
    $('target-path').checked = this.showTargetPath;
    savePref('rp.targetPath', this.showTargetPath);
  }

  setCuePath(on) {
    this.showCuePath = !!on;
    $('cue-path').checked = this.showCuePath;
    savePref('rp.cuePath', this.showCuePath);
  }

  toggleTargetPath() {
    this.setTargetPath(!this.showTargetPath);
    toast(this.showTargetPath ? 'target-ball path on' : 'target-ball path off');
  }

  toggleCuePath() {
    this.setCuePath(!this.showCuePath);
    toast(this.showCuePath ? 'cue-ball path on' : 'cue-ball path off');
  }

  // Keep a physics prediction for the current aim.  Latest-wins: at most one
  // request in flight; when it lands and the aim has moved on, the next frame
  // sends the newest aim right away.  No debounce, so the preview refreshes
  // as fast as the server simulates (a few ms for typical layouts).
  updatePrediction(active) {
    if (!active) return;
    const layoutKey = JSON.stringify([this.cueBallId, this.state.balls.map((b) => [b.id, b.xy])]);
    const params = this.aim.params();
    const key = JSON.stringify([layoutKey, params]);
    this._predWantKey = key;
    if (this.pred && this.pred.layoutKey !== layoutKey) this.pred = null;
    if (this._predInflight || key === this._predSentKey) return;
    this._predSentKey = key;
    this._predInflight = true;
    api.predictTarget({ ...params, cue_ball_id: this.cueBallId })
      .then((res) => {
        const nowLayout = JSON.stringify([this.cueBallId, this.state.balls.map((b) => [b.id, b.xy])]);
        if (nowLayout === layoutKey) this.pred = { key, layoutKey, ...res };
      })
      .catch(() => { /* best-effort: keep the last good prediction */ })
      .finally(() => { this._predInflight = false; });
  }

  // Swap the straight-line ghost ball for the physical first contact
  // (squirt / swerve can make the cue ball touch a different ball -- or none).
  applyPhysicsContact(aim, pred) {
    if (!pred) return aim;
    const lineAt = (p) => {
      const t = (p[0] - aim.lineOrigin[0]) * aim.dir[0] + (p[1] - aim.lineOrigin[1]) * aim.dir[1];
      return [aim.lineOrigin[0] + aim.dir[0] * t, aim.lineOrigin[1] + aim.dir[1] * t];
    };
    if (pred.contact && pred.target) {
      const ghost = pred.contact.cue;
      const objXY = pred.contact.target;
      const n = Math.hypot(objXY[0] - ghost[0], objXY[1] - ghost[1]) || 1;
      return {
        ...aim,
        ghost,
        objBall: { id: pred.target, xy: objXY },
        objDir: [(objXY[0] - ghost[0]) / n, (objXY[1] - ghost[1]) / n],
        lineEnd: lineAt(ghost),
        physicsContact: true,
      };
    }
    if (!pred.target) {
      return { ...aim, ghost: null, objBall: null, objDir: null, lineEnd: aim.wallEnd, physicsContact: true };
    }
    return aim;
  }

  setCameraPreset(preset) {
    this.cameraPreset = preset;
    this.r3d?.setCamera(preset);
    for (const btn of $('camera-toggle').querySelectorAll('button')) {
      btn.classList.toggle('on', btn.dataset.cam === preset);
    }
  }

  refreshUI() {
    $('power').value = v0ToPercent(this.aim.V0);
    $('theta').value = this.aim.theta;
    $('v0-read').textContent = formatShotPower(this.aim.V0);
    $('theta-read').textContent = `${this.aim.theta}°`;
    $('phi-read').textContent = `${this.aim.phi.toFixed(3)}°`;
    document.querySelectorAll('.spin-presets button').forEach((btn) => {
      const match = Math.hypot(this.aim.a - +btn.dataset.a, this.aim.b - +btn.dataset.b) < 0.02;
      btn.classList.toggle('on', match);
    });
    updateStats(this.state);
    renderAttempts(
      this.state,
      (n) => this.replayAttempt(n),
      this.mode === 'playback' ? this.activeAttemptN : null,
    );
    const canRepeat = this.state.can_undo || this.mode === 'playback';
    $('btn-repeat').disabled = $('btn-undo').disabled = !canRepeat;
    this.syncShotPanelLock();
    this.syncPlaybackControls();
    this.syncModeButtons();
  }

  syncShotPanelLock() {
    const locked = this.mode === 'playback' || this.isLiveShotRolling();
    $('shot-panel').classList.toggle('disabled-panel', locked);
    $('power').disabled = locked;
    $('theta').disabled = locked;
    $('btn-shoot').disabled = locked;
    if (this.spinPad) this.spinPad.disabled = locked;
    document.querySelectorAll('.spin-presets button').forEach((btn) => {
      btn.disabled = locked;
    });
  }

  syncPlaybackControls() {
    const canReplay = this.hasReplay();
    const pbBtn = $('mode-toggle')?.querySelector?.('button[data-mode="playback"]');
    if (pbBtn) pbBtn.disabled = !canReplay;

    $('pl-play').disabled = !canReplay;
    $('pl-speed').disabled = !canReplay;
    $('pl-scrub').disabled = !canReplay;

    if (!canReplay) {
      $('pl-play').textContent = '▶';
      $('pl-scrub').value = 0;
      $('pl-scrub').max = 1;
      $('pl-time').textContent = '0.0 / 0.0 s';
      return;
    }

    $('pl-play').textContent = (this.playback.frames && this.playback.playing) ? '❚❚' : '▶';

    let curTime = 0;
    let totalDur = 0;
    if (this.playback.frames) {
      curTime = Math.max(0, this.playback.time);
      totalDur = this.playback.duration || 0;
    } else {
      const n = (this.activeAttemptN && this.attemptShots.has(this.activeAttemptN))
        ? this.activeAttemptN
        : this.latestAttemptN();
      const payload = this.attemptShots.get(n);
      totalDur = payload?.duration || 0;
      curTime = 0;
    }
    if (!this._scrubbing) {
      $('pl-scrub').max = totalDur || 1;
      $('pl-scrub').value = curTime;
      $('pl-time').textContent = `${curTime.toFixed(1)} / ${totalDur.toFixed(1)} s`;
    }
  }

  syncPlayButton() {
    this.syncPlaybackControls();
  }

  togglePlayback() {
    if (!this.hasReplay()) return;
    if (this.mode !== 'playback' || !this.playback.frames) {
      this.replayLast();
      return;
    }
    if (this.playback.playing) this.playback.pause();
    else this.playback.play();
    this.syncPlayButton();
  }

  // ---------- aim ----------

  setAim(patch) {
    Object.assign(this.aim, patch);
    const r = Math.hypot(this.aim.a, this.aim.b);
    if (r > MAX_SPIN_R) {
      this.aim.a = (this.aim.a / r) * MAX_SPIN_R;
      this.aim.b = (this.aim.b / r) * MAX_SPIN_R;
    }
    if (patch.a !== undefined || patch.b !== undefined) {
      this.spinPad.set(this.aim.a, this.aim.b);
    }
    this.refreshUI();
    clearTimeout(this._aimSyncTimer);
    this._aimSyncTimer = setTimeout(() => api.aim(this.aim.params()).catch(() => {}), 250);
  }

  nudgeAim(d) { this.setAim({ phi: (this.aim.phi + d + 360) % 360 }); }
  nudgePower(d) {
    this.setAim({ V0: Math.min(V0_MAX, Math.max(V0_MIN, +(this.aim.V0 + d).toFixed(3))) });
  }

  aimAtBall(ball, exact = false) {
    const cue = this.cueXY();
    const phi = Math.atan2(ball.xy[1] - cue[1], ball.xy[0] - cue[0]) * 180 / Math.PI;
    this.setAim({ phi: (phi + 360) % 360 });
    this.focusCueBall({ alignAim: true });
    if (exact) toast('aimed at ball ' + ball.id);
  }

  // ---------- shooting ----------

  async shoot() {
    if (this.busy) return;
    if (!this.hasCue()) { toast('the cue ball is in the pocket — respawn it first', 'error'); return; }
    // still watching the previous shot? first space skips to its end
    if (this.playback.frames &&
        (this.playback.playing || this.playback.time < this.playback.duration - 1e-3)) {
      this._scrubbing = false;
      this.playback.pause();
      this.playback.seek(this.playback.duration);
      this._firedEvents = this.playback.events.length;
      this.onShotEnd();
      return;
    }
    this.busy = true;
    hideBanner();
    try {
      const payload = await api.shoot({ ...this.aim.params(), cue_ball_id: this.cueBallId });
      this.applyShot(payload);
    } catch (err) {
      toast(err.message, 'error', 4000);
    } finally {
      this.busy = false;
    }
  }

  applyShot(payload) {
    this._savedLiveAim = null;
    this.mode = 'aim';
    this.applyState(payload.state);
    this.attemptShots.set(payload.attempt.n, payload);
    this.activeAttemptN = payload.attempt.n;
    if (this.attemptShots.size > 40) {
      this.attemptShots.delete(this.attemptShots.keys().next().value);
    }
    this.ripples = [];
    this.pocketFlashes = [];
    this._firedEvents = 0;
    this.playback.load(payload);
    this.refreshUI();
  }

  onShotEnd() {
    this.syncPlayButton();
    this.syncShotPanelLock();
    if (this.mode === 'playback') {
      this.refreshUI();
      return;
    }
    const { potted, cue_potted, attempt } = this.lastShotInfo();
    const buttons = [
      { label: '↺ Repeat (R)', accent: true, onClick: () => this.repeatSituation() },
      { label: '◎ Go to cue (C)', onClick: () => { hideBanner(); this.focusCueBall({ alignAim: true }); } },
    ];
    const yellowOnTable = this.state.balls.some((b) => b.id === 'cue');
    if (cue_potted || !this.hasCue() || !yellowOnTable) {
      buttons.push({
        label: 'Respawn cue',
        onClick: async () => {
          this.applyState(await api.respawnCue());
          this.clearAttemptHistory();
          this.playback.clear();
          this.afterSituationChange('cue ball respawned');
          this.focusCueBall();
        },
      });
    }
    if (cue_potted) {
      const others = potted.filter((id) => id !== this.cueBallId);
      showBanner('bad', 'Scratch',
        `${others.length ? `potted ${others.join(', ')} before scratch` : 'cue ball potted'}`,
        buttons);
    } else if (potted.length) {
      const label = potted.map((id) => (id === 'cue' ? 'cue (svoyak)' : id)).join(', ');
      showBanner('good', `Potted ${label}`,
        `#${attempt.n} · ${attempt.cushion_hits} cushions · ${attempt.duration.toFixed(1)} s`,
        buttons);
    } else {
      showBanner('bad', 'Missed',
        `#${attempt.n} · ${attempt.cushion_hits} cushions`,
        buttons);
    }
  }

  lastShotInfo() {
    const payload = [...this.attemptShots.values()].pop();
    if (payload) {
      return { potted: payload.potted, cue_potted: payload.cue_potted, attempt: payload.attempt };
    }
    return { potted: [], cue_potted: false, attempt: { n: 0, cushion_hits: 0, duration: 0 } };
  }

  // ---------- situation management ----------

  async startFullRack() {
    try {
      this.applyState(await api.setDrill('rack'));
      this.clearAttemptHistory();
      this.afterSituationChange('new game — 15 white balls racked');
      this.focusCueBall({ alignAim: true });
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async repeatSituation() {
    const fromPlayback = this.mode === 'playback';
    const playbackAim = fromPlayback ? { ...this.aim.params() } : null;
    const playbackCueId = fromPlayback ? this.playback.shotCue?.cueBallId : null;

    if (!this.state.can_undo && !fromPlayback) {
      toast('nothing to repeat yet');
      return;
    }
    try {
      this._savedLiveAim = null;
      this.mode = 'aim';
      if (this.state.can_undo) {
        this.applyState(await api.undo());
      }
      if (fromPlayback && playbackAim) {
        this.state.aim = { ...playbackAim };
        if (playbackCueId && this.state.balls.some((b) => b.id === playbackCueId)) {
          this.cueBallId = playbackCueId;
          this.focusBallId = playbackCueId;
          this.state.cue_ball_id = playbackCueId;
          for (const b of this.state.balls) b.is_cue = (b.id === playbackCueId);
          api.setCueBall(playbackCueId).catch(() => {});
        }
        api.aim(playbackAim).catch(() => {});
      }
      this.afterSituationChange('situation restored — same ball, same angle');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  afterSituationChange(msg) {
    this._savedLiveAim = null;
    if (this.mode === 'playback') this.mode = 'aim';
    this.playback.clear();
    hideBanner();
    Object.assign(this.aim, this.state.aim);
    this.spinPad.set(this.aim.a, this.aim.b);
    this.updateControls();
    this.refreshUI();
    if (msg) toast(msg);
  }

  enterPlaybackForAttempt(n, { autoPlay = true } = {}) {
    const payload = this.attemptShots.get(n);
    if (!payload) {
      toast('attempt frames are gone (page was loaded)');
      return false;
    }
    if (this.mode !== 'playback') {
      this._savedLiveAim = { ...this.aim.params() };
    }
    this.activeAttemptN = n;
    this.mode = 'playback';
    hideBanner();
    this.ripples = [];
    this.pocketFlashes = [];
    this._firedEvents = 0;
    this.playback.load(payload);
    if (!autoPlay) {
      this.playback.pause();
      this.playback.seek(0);
    }
    if (payload.attempt?.params) {
      Object.assign(this.aim, payload.attempt.params);
      this.spinPad.set(this.aim.a, this.aim.b);
    }
    this.updateControls();
    this.refreshUI();
    return true;
  }

  replayLast() {
    const n = (this.activeAttemptN && this.attemptShots.has(this.activeAttemptN))
      ? this.activeAttemptN
      : this.latestAttemptN();
    if (!n) { toast('no shots to replay yet'); return; }
    this.replayAttempt(n);
  }

  replayAttempt(n) {
    this.enterPlaybackForAttempt(n, { autoPlay: true });
  }

  // ---------- ball editing ----------

  onDragPreview(preview) {
    this.dragPreview = preview ? { id: preview.id, xy: preview.xy } : null;
    this.updateControls();
  }

  async moveBall(id, xy) {
    try {
      this.applyState(await api.moveBall(id, xy));
      this.clearAttemptHistory();
      this.afterSituationChange(null);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async addBall(xy) {
    try {
      const res = await api.addBall(xy);
      this.applyState(res.state);
      this.clearAttemptHistory();
      this.afterSituationChange(`added ball ${res.id}`);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async removeBall(id) {
    try {
      this.applyState(await api.removeBall(id));
      this.clearAttemptHistory();
      this.afterSituationChange(`removed ball ${id}`);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // ---------- camera focus & cue-ball selection ----------

  setFocusBall(id, { alignAim = false } = {}) {
    if (this.mode === 'playback') {
      this.setMode('aim');
    }
    this._scrubbing = false;
    if (this.playback.frames) {
      this.playback.clear();
    }
    hideBanner();
    this.focusBallId = id;
    this.cueBallId = id;
    if (this.state?.balls) {
      this.state.cue_ball_id = id;
      for (const b of this.state.balls) b.is_cue = (b.id === id);
      this.state.cue_on_table = this.state.balls.some((b) => b.id === id);
    }
    api.setCueBall(id).catch(() => {});
    this.refreshUI();
    const ball = this.staticBalls().find((b) => b.id === id);
    if (ball && this.r3d) {
      this.r3d.focusOn(ball.xy[0], ball.xy[1], this.ballRadius, {
        smooth: true,
        phi: alignAim ? this.aim.phi : null,
      });
    }
    toast(id === 'cue' ? 'shooting with yellow ball' : `shooting with ball ${id}`);
  }

  focusCueBall({ alignAim = true } = {}) {
    if (this.mode === 'playback') {
      this.setMode('aim');
    }
    let targetId = this.cueBallId;
    if (!this.state.balls.some((b) => b.id === targetId)) {
      const fallback = this.state.balls.find((b) => b.id === 'cue') || this.state.balls[0];
      if (!fallback) {
        toast('no balls on table — respawn cue or rack', 'error');
        return;
      }
      targetId = fallback.id;
    }
    hideBanner();
    this.setFocusBall(targetId, { alignAim });
  }

  // Resolve which ball the camera should orbit: the chosen one, else the
  // cue ball, else any ball (the cue may be in a pocket).
  computeFocus(balls) {
    const visible = balls.filter((b) => !b.hidden);
    let ball = visible.find((b) => b.id === this.focusBallId)
      || visible.find((b) => b.isCue)
      || visible[0];
    if (ball) {
      this._lastFocus = { id: ball.id, xy: ball.xy, z: ball.z ?? this.ballRadius };
      if (ball.id !== this.focusBallId) this.focusBallId = ball.id;
      return this._lastFocus;
    }
    return this._lastFocus || null;   // everything potted: hold the last point
  }

  // ---------- modes ----------

  setShift(on) {
    if (this.shiftHeld === on) return;
    this.shiftHeld = on;
    this.updateControls();
  }

  // Camera is free unless Shift is held (aim mode) or a ball is being
  // dragged (place mode).
  updateControls() {
    const wrap = $('table-wrap');
    if (!this.r3d) {
      wrap.style.cursor = 'crosshair';
      return;
    }
    const cameraFree = this.mode === 'place'
      ? !this.dragPreview
      : (this.mode === 'playback' ? true : !this.shiftHeld);
    this.r3d.setInteractive(cameraFree);
    wrap.style.cursor = this.mode === 'place'
      ? 'move'
      : (this.mode === 'aim' && this.shiftHeld ? 'crosshair' : 'grab');
  }

  syncModeButtons() {
    for (const btn of $('mode-toggle').querySelectorAll('button')) {
      btn.classList.toggle('on', btn.dataset.mode === this.mode);
    }
    if (this.mode === 'place') {
      setHint('drag balls to move · click cloth to add · right-click to remove · right-drag/WASD moves camera · M to aim');
    } else if (this.mode === 'playback') {
      setHint('Playback mode · space plays/pauses · drag slider to scrub · WASD/right-drag explores · Aim or Esc to exit');
    } else {
      setHint('Shift+click/drag target aims · drag orbits · WASD / right-drag explores table · C returns to cue · space shoots');
    }
  }

  setMode(mode) {
    if (mode === 'playback') {
      if (!this.hasReplay()) return;
      if (this.mode !== 'playback' || !this.playback.frames) {
        this.replayLast();
      }
      return;
    }
    const wasPlayback = this.mode === 'playback';
    this.mode = mode;
    if (wasPlayback) {
      if (this._savedLiveAim) {
        Object.assign(this.aim, this._savedLiveAim);
        this.spinPad.set(this.aim.a, this.aim.b);
        this._savedLiveAim = null;
      }
      this.playback.clear();
    }
    this.updateControls();
    this.refreshUI();
  }

  toggleMode() {
    if (this.mode === 'playback') this.setMode('aim');
    else this.setMode(this.mode === 'aim' ? 'place' : 'aim');
  }
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
    const now = performance.now() / 1000;
    this.ripples = this.ripples.filter((r) => now - r.t0 < 0.7);
    this.pocketFlashes = this.pocketFlashes.filter((f) => now - f.t0 < 0.8);
  }

  buildScene() {
    const inPlayback = this.mode === 'playback' && !!this.playback.frames;
    const liveRolling = this.isLiveShotRolling();
    const playing = Boolean(inPlayback || liveRolling);
    let balls;
    if (playing && !this.dragPreview) {
      balls = this.playback.visualBalls(this.staticBalls(), this.viewMode === '2d');
    } else {
      balls = this.staticBalls();
    }
    const cue = balls.find((b) => b.isCue && !b.hidden);
    let aim = null;
    const aiming = !!cue && !playing && this.mode === 'aim' && !this.dragPreview;
    this.updatePrediction(aiming);
    const pred = aiming ? this.pred : null;
    let targetPath = null, cuePath = null;
    if (pred && this.showTargetPath && pred.target && pred.path?.xyz?.length > 1) {
      targetPath = { key: pred.key, pts: pred.path.xyz, potted: pred.potted, id: pred.target };
    }
    if (pred && this.showCuePath && pred.cue?.path?.xyz?.length > 1) {
      cuePath = { key: pred.key, pts: pred.cue.path.xyz, potted: pred.cue.potted };
    }
    if (cue && !playing && this.mode === 'aim') {
      aim = this.applyPhysicsContact({
        ...this.aim.preview(cue.xy, this.staticBalls()),
        ...this.aim.params(),
        showLine: true,
        showSpin: true,
      }, pred);
    } else if (playing && this.playback.shotCue) {
      const sc = this.playback.shotCue;
      aim = {
        cue: sc.xy,
        ballR: this.ballRadius,
        stick: this.aim.stickGeometry(sc.xy, sc.params, this.playback.cuePull()),
        ...sc.params,
        showLine: false,
        showSpin: false,
      };
    }
    return {
      balls,
      playing,
      focus: this.computeFocus(balls),
      aim,
      targetPath,
      cuePath,
      trails: this.playback.trailPts,
      trailsOn: $('trails').checked && playing,
      ripples: this.ripples,
      pocketFlashes: this.pocketFlashes,
      now: performance.now() / 1000,
    };
  }

  stepFreeCamera(dt) {
    if (!this.r3d || !this.interact?.moveKeys?.size || dt <= 0) return;
    const keys = this.interact.moveKeys;
    const speed = this.shiftHeld ? 3.4 : 1.85;
    const fwd = ((keys.has('w') ? 1 : 0) - (keys.has('s') ? 1 : 0)) * speed;
    const right = ((keys.has('d') ? 1 : 0) - (keys.has('a') ? 1 : 0)) * speed;
    const up = ((keys.has('e') ? 1 : 0) - (keys.has('q') ? 1 : 0)) * (speed * 0.65);
    this.r3d.panCamera(fwd, right, up, dt);
  }

  frame() {
    this.frameCount = (this.frameCount || 0) + 1;
    const nowMs = performance.now();
    const dt = Math.min((nowMs - (this._lastFrameTime ?? nowMs)) / 1000, 0.1);
    this._lastFrameTime = nowMs;
    try {
      this.stepFreeCamera(dt);
      this.playback.tick();
      this.fireEvents();
      const scene = this.buildScene();
      if (this.viewMode === '3d' && this.r3d) {
        // frame the TV camera on the followed ball once we know where it is
        if (!this._framed && scene.focus) {
          this.r3d.follow(scene.focus.xy[0], scene.focus.xy[1], scene.focus.z);
          this.setCameraPreset(this.cameraPreset || 'tv');
          this._framed = true;
        }
        this.r3d.draw(scene);
      } else if (this.r2d) {
        this.r2d.draw(scene, this.view);
      }
    } catch (err) {
      if (!this._frameError) {
        this._frameError = true;
        console.error('render loop error:', err);
        toast(`render error: ${err.message}`, 'error', 8000);
      }
      // keep the loop alive; scene may recover after a view change
    }

    this.syncPlaybackControls();
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

function loadPref(key, fallback) {
  try {
    const v = globalThis.localStorage?.getItem(key);
    return v === null || v === undefined ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

function savePref(key, on) {
  try { globalThis.localStorage?.setItem(key, on ? '1' : '0'); } catch { /* private mode */ }
}

const app = new App();
globalThis.__russianPyramidApp = app;  // handy in the devtools console
(globalThis.__RP_APPS ??= []).push(app);
app.init().catch((err) => {
  document.body.insertAdjacentHTML('afterbegin',
    `<div style="color:#e5544b;padding:20px;font-family:monospace">failed to start: ${err}</div>`);
});
