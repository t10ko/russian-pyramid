// Pointer + keyboard interaction: aiming, dragging balls, shortcuts.

import { angleDeg } from './geometry.js';

export class Interact {
  constructor(canvas, app) {
    this.canvas = canvas;
    this.app = app;          // main.js controller
    this.dragBall = null;    // {id, offset, xy}
    this.dragAim = false;
    this.moved = false;

    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', () => this.cancel());
    canvas.addEventListener('dblclick', (e) => this.dbl(e));
    canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); this.altClick(e); });
    canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });

    window.addEventListener('keydown', (e) => this.key(e));
  }

  // canvas px -> table coords
  tablePos(e) {
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    return [this.app.view.tx(px), this.app.view.ty(py)];
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
    const xy = this.tablePos(e);
    this.moved = false;
    const ball = this.ballAt(xy);

    if (this.app.mode === 'place') {
      if (ball) {
        this.dragBall = { id: ball.id, offset: [ball.xy[0] - xy[0], ball.xy[1] - xy[1]], xy: ball.xy };
        this.canvas.setPointerCapture(e.pointerId);
      } else {
        this.app.addBall(xy);
      }
      return;
    }

    // aim mode: pressing anywhere starts steering the aim from the cue ball
    if (this.app.hasCue()) {
      this.dragAim = true;
      this.canvas.setPointerCapture(e.pointerId);
      if (ball && ball.id !== 'cue' && !this.app.nearCue(xy)) {
        this.app.aimAtBall(ball);
      }
      this.app.setAim({ phi: this.phiToward(xy) });
    }
  }

  move(e) {
    if (this.dragBall) {
      const xy = this.tablePos(e);
      this.dragBall.xy = [
        xy[0] + this.dragBall.offset[0],
        xy[1] + this.dragBall.offset[1],
      ];
      this.moved = true;
      this.app.onDragPreview(this.dragBall);
    } else if (this.dragAim && this.hasMovedEnough(e)) {
      this.app.setAim({ phi: this.phiToward(this.tablePos(e)) });
    }
  }

  hasMovedEnough(e) {
    if (!this._last) this._last = { x: e.clientX, y: e.clientY, live: false };
    const d = Math.hypot(e.clientX - this._last.x, e.clientY - this._last.y);
    if (d > 3) { this._last.live = true; }
    return this._last.live;
  }

  phiToward(xy) {
    const cue = this.app.cueXY();
    return angleDeg(xy[0] - cue[0], xy[1] - cue[1]);
  }

  up() {
    if (this.dragBall) {
      const { id, xy } = this.dragBall;
      this.app.moveBall(id, xy);
    }
    this.dragBall = null;
    this.dragAim = false;
    this._last = null;
    this.app.onDragPreview(null);
  }

  cancel() {
    this.dragBall = null;
    this.dragAim = false;
    this._last = null;
    this.app.onDragPreview(null);
  }

  dbl(e) {
    if (this.app.mode !== 'aim') return;
    const ball = this.ballAt(this.tablePos(e));
    if (ball && ball.id !== 'cue') this.app.aimAtBall(ball, true);
  }

  altClick(e) {
    if (this.app.mode !== 'place') return;
    const ball = this.ballAt(this.tablePos(e));
    if (ball && !ball.isCue) this.app.removeBall(ball.id);
  }

  wheel(e) {
    if (this.app.mode !== 'aim' || !this.app.hasCue()) return;
    e.preventDefault();
    const step = e.shiftKey ? 0.5 : 0.1;
    this.app.nudgePower(e.deltaY < 0 ? step : -step);
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
      case 'm': case 'M': app.toggleMode(); break;
      case 'a': case 'A': app.toggleAssist(); break;
      case 'ArrowLeft': e.preventDefault(); app.nudgeAim(coarse ? 0.5 : -0.05); break;
      case 'ArrowRight': e.preventDefault(); app.nudgeAim(coarse ? -0.5 : 0.05); break;
      case 'ArrowUp': e.preventDefault(); app.nudgePower(coarse ? 0.5 : 0.1); break;
      case 'ArrowDown': e.preventDefault(); app.nudgePower(coarse ? -0.5 : -0.1); break;
      case '?': app.showHelp(); break;
      default: break;
    }
  }
}
