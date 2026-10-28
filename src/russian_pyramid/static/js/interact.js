// Pointer + keyboard interaction: aiming, dragging balls, shortcuts.
// Attached to the table wrapper so it works for both the 2D and 3D
// renderers; pointer handlers ignore events that didn't land on the active
// canvas (banner, hints, etc.).

import { angleDeg } from './geometry.js';

export class Interact {
  constructor(wrapper, app) {
    this.wrapper = wrapper;
    this.app = app;          // main.js controller
    this.dragBall = null;    // {id, offset, xy}
    this.dragAim = false;
    this.moved = false;

    wrapper.addEventListener('pointerdown', (e) => this.down(e));
    wrapper.addEventListener('pointermove', (e) => this.move(e));
    wrapper.addEventListener('pointerup', (e) => this.up(e));
    wrapper.addEventListener('pointercancel', () => this.cancel());
    wrapper.addEventListener('dblclick', (e) => this.dbl(e));
    wrapper.addEventListener('contextmenu', (e) => { e.preventDefault(); this.altClick(e); });
    wrapper.addEventListener('wheel', (e) => this.wheel(e), { passive: false });

    window.addEventListener('keydown', (e) => this.key(e));
  }

  onCanvas(e) {
    return e.target === this.app.activeCanvas();
  }

  // pointer event -> table coordinates (via the active renderer)
  tablePos(e) {
    const canvas = this.app.activeCanvas();
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    return this.app.renderer?.tableFromClient(px, py);
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
    if (e.button === 2 || e.altKey) return;      // handled by contextmenu
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

    // aim mode: the plain drag belongs to the camera -- the cue moves when
    // Shift is held (the headless 2D path always aims; it has no camera)
    const canAim = this.app.viewMode === '2d' || e.shiftKey;
    if (this.app.hasCue() && canAim) {
      this.dragAim = true;
      this.wrapper.setPointerCapture(e.pointerId);
      const phi = this.phiFromCueSide(xy);
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
      const xy = this.tablePos(e);
      const phi = xy ? this.phiFromCueSide(xy) : null;
      if (phi !== null) {
        this.moved = true;
        this.app.setAim({ phi });
      }
    }
  }

  // Pointer is on the cue-stick side (behind the cue ball), so the shot
  // direction points from the pointer through the cue ball.
  phiFromCueSide(xy) {
    const cue = this.app.cueXY();
    const dx = cue[0] - xy[0];
    const dy = cue[1] - xy[1];
    if (Math.hypot(dx, dy) < 1e-4) return null;
    return angleDeg(dx, dy);
  }

  phiToward(xy) {
    return this.phiFromCueSide(xy);
  }

  up(e) {
    if (this.dragBall) {
      const { id, xy } = this.dragBall;
      this.app.moveBall(id, xy);
    } else if (!this.moved && this._downAt && !e?.shiftKey) {
      const dist = Math.hypot(e.clientX - this._downAt.x, e.clientY - this._downAt.y);
      if (dist < 5) {
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
    this._last = null;
    this._downAt = null;
    this.app.onDragPreview(null);
  }

  cancel() {
    this.dragBall = null;
    this.dragAim = false;
    this._last = null;
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
    if (!this.onCanvas(e) || this.app.mode !== 'place') return;
    const xy = this.tablePos(e);
    if (!xy) return;
    const ball = this.ballAt(xy);
    if (ball && !ball.isCue) this.app.removeBall(ball.id);
  }

  wheel(e) {
    if (!this.onCanvas(e)) return;
    if (this.app.mode !== 'aim' || !this.app.hasCue()) return;
    // the wheel zooms the camera; Shift+wheel (or dragging aim + wheel) sets power
    if (this.app.viewMode === '3d' && !e.shiftKey && !this.dragAim) return;
    e.preventDefault();
    // macOS maps Shift+scroll to deltaX (leaving deltaY = 0), so inspect both axes
    const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (Math.abs(delta) < 1e-6) return;
    const step = 0.25;
    this.app.nudgePower(delta < 0 ? step : -step);
  }

  key(e) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    const app = this.app;
    const coarse = e.shiftKey;
    switch (e.key) {
      case ' ': e.preventDefault(); app.shoot(); break;
      case 'r': case 'R': app.repeatSituation(); break;
      case 'u': case 'U': app.repeatSituation(); break;
      case 'p': case 'P': app.replayLast(); break;
      case 'c': case 'C': app.focusCueBall(); break;
      case 'n': case 'N': app.startFullRack(); break;
      case 'm': case 'M': app.toggleMode(); break;
      case 'ArrowLeft': e.preventDefault(); app.nudgeAim(coarse ? 0.5 : -0.05); break;
      case 'ArrowRight': e.preventDefault(); app.nudgeAim(coarse ? -0.5 : 0.05); break;
      case 'ArrowUp': e.preventDefault(); app.nudgePower(coarse ? 0.5 : 0.1); break;
      case 'ArrowDown': e.preventDefault(); app.nudgePower(coarse ? -0.5 : -0.1); break;
      case '?': app.showHelp(); break;
      default: break;
    }
  }
}
