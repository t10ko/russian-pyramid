// Pointer + keyboard interaction: aiming, dragging balls, free camera movement, shortcuts.
// Attached to the table wrapper so it works for both the 2D and 3D
// renderers; pointer handlers ignore events that didn't land on the active
// canvas (banner, hints, etc.).

import { MAX_SPIN_R } from './aim.js';
import { angleDeg, normAngleDeg, rad2deg } from './geometry.js';

const MOVE_CODES = {
  KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd', KeyQ: 'q', KeyE: 'e',
};
const MOVE_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e']);

export class Interact {
  constructor(wrapper, app) {
    this.wrapper = wrapper;
    this.app = app;          // main.js controller
    this.dragBall = null;    // {id, offset, xy}
    this.dragAim = false;
    this.moved = false;
    this.moveKeys = new Set();
    this._rightDownAt = null;

    wrapper.addEventListener('pointerdown', (e) => this.down(e));
    wrapper.addEventListener('pointermove', (e) => this.move(e));
    wrapper.addEventListener('pointerup', (e) => this.up(e));
    wrapper.addEventListener('pointercancel', () => this.cancel());
    wrapper.addEventListener('dblclick', (e) => this.dbl(e));
    wrapper.addEventListener('contextmenu', (e) => { e.preventDefault(); this.altClick(e); });
    wrapper.addEventListener('wheel', (e) => this.wheel(e), { passive: false });

    window.addEventListener('keydown', (e) => this.key(e));
    window.addEventListener('keyup', (e) => this.keyUp(e));
    window.addEventListener('blur', () => this.moveKeys.clear());
  }

  onCanvas(e) {
    return e.target === this.app.activeCanvas();
  }

  // pointer event -> table coordinates on the ball-center cloth plane
  tablePos(e) {
    const canvas = this.app.activeCanvas();
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    return this.app.renderer?.tableFromClient(px, py);
  }

  // pointer event -> target point for aiming (hits 3D target-ball surface first, else cloth plane)
  aimPos(e) {
    const canvas = this.app.activeCanvas();
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const r = this.app.renderer;
    if (r?.aimFromClient) return r.aimFromClient(px, py, this.app.cueBallId);
    return r?.tableFromClient(px, py);
  }

  ballAt(xy) {
    const r = this.app.ballRadius * 1.4;
    let best = null, bestD = Infinity;
    for (const b of this.app.staticBalls()) {
      const d = Math.hypot(b.xy[0] - xy[0], b.xy[1] - xy[1]);
      if (d < r && d < bestD) { best = b; bestD = d; }
    }
    return best;
  }

  down(e) {
    if (e.button === 2 || e.altKey) {
      this._rightDownAt = { x: e.clientX, y: e.clientY };
      return; // stationary right-click handled by contextmenu; right-drag pans camera
    }
    if (e.button !== 0 || e.ctrlKey || e.metaKey) return; // let OrbitControls pan on Middle / Cmd+drag
    if (!this.onCanvas(e)) return;
    const xy = this.tablePos(e);
    if (!xy) return;
    this._downAt = { x: e.clientX, y: e.clientY };
    this.moved = false;
    const ball = this.ballAt(xy);

    if (this.app.mode === 'place') {
      if (ball) {
        this.dragBall = { id: ball.id, offset: [ball.xy[0] - xy[0], ball.xy[1] - xy[1]], xy: ball.xy };
        this.wrapper.setPointerCapture(e.pointerId);
      }
      return;
    }

    // aim mode: plain drag belongs to the camera -- the cue aims immediately at
    // the clicked/dragged target when Shift is held (headless 2D always aims).
    const canAim = this.app.mode === 'aim' && !this.app.isLiveShotRolling() &&
      (this.app.viewMode === '2d' || e.shiftKey);
    if (this.app.hasCue() && canAim) {
      this.dragAim = true;
      this.wrapper.setPointerCapture(e.pointerId);
      const targetXY = this.aimPos(e) || xy;
      const phi = this.phiToward(targetXY);
      if (phi !== null) this.app.setAim({ phi });
    }
  }

  move(e) {
    if (this.dragBall) {
      const xy = this.tablePos(e);
      if (!xy) return;
      this.dragBall.xy = [
        xy[0] + this.dragBall.offset[0],
        xy[1] + this.dragBall.offset[1],
      ];
      this.moved = true;
      this.app.onDragPreview(this.dragBall);
    } else if (this.dragAim) {
      const targetXY = this.aimPos(e);
      const phi = targetXY ? this.phiToward(targetXY) : null;
      if (phi !== null) {
        this.moved = true;
        this.app.setAim({ phi });
      }
    }
  }

  // Aim the cue's sightline from the cue ball directly through the target `xy`.
  // Accounts for horizontal off-center parallel shift (`a`) so the collinear
  // dashed aiming line lands right on `xy`.
  phiToward(xy) {
    const cue = this.app.cueXY();
    const dx = xy[0] - cue[0];
    const dy = xy[1] - cue[1];
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-4) return null;
    const alpha = angleDeg(dx, dy);
    const ca = Math.max(-MAX_SPIN_R, Math.min(MAX_SPIN_R, this.app.aim?.a || 0));
    const sideOffset = (this.app.ballRadius || 0) * ca;
    if (Math.abs(sideOffset) > 1e-6 && dist > Math.abs(sideOffset) * 1.2) {
      return normAngleDeg(alpha - rad2deg(Math.asin(sideOffset / dist)));
    }
    return alpha;
  }

  up(e) {
    if (this.dragBall) {
      const { id, xy } = this.dragBall;
      this.app.moveBall(id, xy);
    } else if (!this.moved && this._downAt && !e?.shiftKey && !e?.ctrlKey && !e?.metaKey) {
      const dist = Math.hypot(e.clientX - this._downAt.x, e.clientY - this._downAt.y);
      if (dist < 7) {
        const xy = this.tablePos(e);
        if (xy) {
          const ball = this.ballAt(xy);
          if (this.app.mode === 'place' && !ball) {
            this.app.addBall(xy);
          } else if (this.app.mode === 'aim' && ball) {
            this.app.setFocusBall(ball.id);
          }
        }
      }
    }
    this.dragBall = null;
    this.dragAim = false;
    this._downAt = null;
    this.app.onDragPreview(null);
  }

  cancel() {
    this.dragBall = null;
    this.dragAim = false;
    this._downAt = null;
    this._rightDownAt = null;
    this.app.onDragPreview(null);
  }

  dbl(e) {
    if (!this.onCanvas(e) || this.app.mode !== 'aim') return;
    const xy = this.tablePos(e);
    if (!xy) return;
    const ball = this.ballAt(xy);
    if (ball && ball.id !== this.app.cueBallId) this.app.aimAtBall(ball, true);
  }

  altClick(e) {
    const down = this._rightDownAt;
    this._rightDownAt = null;
    if (!this.onCanvas(e) || this.app.mode !== 'place') return;
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) >= 6) return; // right-dragged to pan
    const xy = this.tablePos(e);
    if (!xy) return;
    const ball = this.ballAt(xy);
    if (ball && !ball.isCue) this.app.removeBall(ball.id);
  }

  wheel(e) {
    if (!this.onCanvas(e)) return;
    if (this.app.mode !== 'aim' || this.app.isLiveShotRolling() || !this.app.hasCue()) return;
    // the wheel zooms the camera; Shift+wheel (or dragging aim + wheel) sets power
    if (this.app.viewMode === '3d' && !e.shiftKey && !this.dragAim) return;
    e.preventDefault();
    // macOS maps Shift+scroll to deltaX (leaving deltaY = 0), so inspect both axes
    const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (Math.abs(delta) < 1e-6) return;
    const step = 0.25;
    this.app.nudgePower(delta < 0 ? step : -step);
  }

  _moveKeyFromEvent(e) {
    if (e.code && MOVE_CODES[e.code]) return MOVE_CODES[e.code];
    const k = typeof e.key === 'string' ? e.key.toLowerCase() : '';
    return MOVE_KEYS.has(k) ? k : null;
  }

  keyUp(e) {
    const mk = this._moveKeyFromEvent(e);
    if (mk) this.moveKeys.delete(mk);
  }

  key(e) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (!e.metaKey && !e.ctrlKey && !e.altKey) {
      const mk = this._moveKeyFromEvent(e);
      if (mk) {
        this.moveKeys.add(mk);
        return;
      }
    }
    const app = this.app;
    const coarse = e.shiftKey;
    const canEditAim = app.mode === 'aim' && !app.isLiveShotRolling();
    switch (e.key) {
      case ' ':
        e.preventDefault();
        if (app.mode === 'playback') app.togglePlayback();
        else app.shoot();
        break;
      case 'Escape':
        if (app.mode === 'playback') app.setMode('aim');
        break;
      case 'r': case 'R': app.repeatSituation(); break;
      case 'u': case 'U': app.repeatSituation(); break;
      case 'p': case 'P': app.replayLast(); break;
      case 'c': case 'C': app.focusCueBall({ alignAim: true }); break;
      case 'n': case 'N': app.startFullRack(); break;
      case 'm': case 'M': app.toggleMode(); break;
      case 'ArrowLeft': if (canEditAim) { e.preventDefault(); app.nudgeAim(coarse ? 0.5 : -0.05); } break;
      case 'ArrowRight': if (canEditAim) { e.preventDefault(); app.nudgeAim(coarse ? -0.5 : 0.05); } break;
      case 'ArrowUp': if (canEditAim) { e.preventDefault(); app.nudgePower(coarse ? 0.5 : 0.1); } break;
      case 'ArrowDown': if (canEditAim) { e.preventDefault(); app.nudgePower(coarse ? -0.5 : -0.1); } break;
      case '?': app.showHelp(); break;
      default: break;
    }
  }
}
