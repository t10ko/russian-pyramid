// Canvas rendering: static table layer (wood, cloth, cushions, pockets,
// sights) baked once per resize, plus the dynamic scene (balls, aim overlay,
// trails, ripples) drawn every frame.

import { TAU } from './geometry.js';

export const CLOTHS = {
  green: { felt: '#0d7048', feltDark: '#08522f', cushion: '#0a6140', jaw: '#0e6b46' },
  blue: { felt: '#1362a0', feltDark: '#0d4776', cushion: '#10578c', jaw: '#125f96' },
  red: { felt: '#9c3038', feltDark: '#6f1f26', cushion: '#8a2a31', jaw: '#932f36' },
};

const WOOD_A = '#59371f';
const WOOD_B = '#3d2413';
const WOOD_EDGE = '#2b1a0d';
const SIGHT = '#e8dcc0';

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.layer = null;          // offscreen static table
    this.cloth = 'green';
    this.dpr = 1;
    this.view = null;
  }

  resize(view) {
    this.view = view;
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    view.resize(rect.width, rect.height);
    this.bakeTable(view);
  }

  setOrientation(orientation, view) {
    view.orientation = orientation;
    this.resize(view);
  }

  // pointer (canvas-relative px) -> table (x, y); null when off-canvas
  tableFromClient(px, py) {
    if (!this.view) return null;
    return this.view.fromCanvas(px, py);
  }

  // ----- static layer -------------------------------------------------------

  bakeTable(view) {
    const { width: W, height: H } = this.canvas;
    const layer = document.createElement('canvas');
    layer.width = W;
    layer.height = H;
    const g = layer.getContext('2d');
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const t = view.table;
    const cw = t.cushion_width;
    const wood = 0.085;                     // visible wood width beyond cushions (m)
    const c = CLOTHS[this.cloth];

    // --- wood frame ---
    const fx0 = view.cx(0, 0) - view.m(cw + wood);
    const fy0 = view.cy(0, 0) - view.m(cw + wood);
    const fw = view.m(t.l) + 2 * view.m(cw + wood);
    const fh = view.m(t.w) + 2 * view.m(cw + wood);
    const r = Math.min(fw, fh) * 0.045;
    const grad = g.createLinearGradient(fx0, fy0, fx0, fy0 + fh);
    grad.addColorStop(0, WOOD_A);
    grad.addColorStop(0.5, WOOD_B);
    grad.addColorStop(1, WOOD_A);
    roundRect(g, fx0, fy0, fw, fh, r);
    g.fillStyle = grad;
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = WOOD_EDGE;
    g.stroke();

    // subtle wood grain
    g.save();
    roundRect(g, fx0, fy0, fw, fh, r);
    g.clip();
    g.globalAlpha = 0.08;
    g.strokeStyle = '#000';
    g.lineWidth = 1;
    for (let i = 0; i < 46; i++) {
      const yy = fy0 + (i / 46) * fh + Math.sin(i * 3.7) * 3;
      g.beginPath();
      g.moveTo(fx0, yy);
      g.bezierCurveTo(fx0 + fw * 0.3, yy + 5, fx0 + fw * 0.7, yy - 5, fx0 + fw, yy);
      g.stroke();
    }
    g.restore();

    // --- cushion band ---
    const bx0 = view.cx(0, 0) - view.m(cw);
    const by0 = view.cy(0, 0) - view.m(cw);
    const bw = view.m(t.l) + 2 * view.m(cw);
    const bh = view.m(t.w) + 2 * view.m(cw);
    roundRect(g, bx0, by0, bw, bh, r * 0.55);
    g.fillStyle = c.cushion;
    g.fill();

    // --- cloth (play field) ---
    const px0 = view.cx(0, 0), py0 = view.cy(0, 0);
    const pw = view.m(t.l), ph = view.m(t.w);
    const felt = g.createRadialGradient(
      px0 + pw / 2, py0 + ph / 2, Math.min(pw, ph) * 0.1,
      px0 + pw / 2, py0 + ph / 2, Math.max(pw, ph) * 0.62,
    );
    felt.addColorStop(0, c.felt);
    felt.addColorStop(1, c.feltDark);
    g.fillStyle = felt;
    g.fillRect(px0, py0, pw, ph);

    // cloth speckle
    g.save();
    g.beginPath();
    g.rect(px0, py0, pw, ph);
    g.clip();
    g.globalAlpha = 0.05;
    g.fillStyle = '#ffffff';
    let seed = 7;
    const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 1400; i++) {
      g.fillRect(px0 + rand() * pw, py0 + rand() * ph, 1, 1);
    }
    g.restore();

    // --- cloth markings: head string + spots (lines only, like the real cloth)
    g.save();
    g.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    g.fillStyle = 'rgba(255, 255, 255, 0.22)';
    g.lineWidth = Math.max(1.2, view.m(0.0035));

    const yHead = t.l / 4, yFoot = (3 * t.l) / 4, cxm = t.w / 2;
    g.beginPath();
    g.moveTo(view.cx(0.06, yHead), view.cy(0.06, yHead));
    g.lineTo(view.cx(t.w - 0.06, yHead), view.cy(t.w - 0.06, yHead));
    g.stroke();
    for (const sy of [yHead, t.l / 2, yFoot]) {
      g.beginPath();
      g.arc(view.cx(cxm, sy), view.cy(cxm, sy), view.m(0.009), 0, TAU);
      g.fill();
    }
    g.restore();

    // --- physics cushion noses: the exact lines the solver collides with ---
    g.strokeStyle = 'rgba(255, 255, 255, 0.13)';
    g.lineWidth = Math.max(1.5, view.m(0.006));
    g.lineCap = 'round';
    for (const seg of t.linear_segments) {
      g.beginPath();
      g.moveTo(view.cx(seg.p1[1], seg.p1[0]), view.cy(seg.p1[1], seg.p1[0]));
      g.lineTo(view.cx(seg.p2[1], seg.p2[0]), view.cy(seg.p2[1], seg.p2[0]));
      g.stroke();
    }

    // --- pockets ---
    for (const p of t.pockets) {
      const cx = view.cx(p.center[1], p.center[0]);
      const cy = view.cy(p.center[1], p.center[0]);
      const pr = view.m(p.radius * 1.12);
      const hole = g.createRadialGradient(cx, cy, pr * 0.2, cx, cy, pr);
      hole.addColorStop(0, '#000');
      hole.addColorStop(0.75, '#050708');
      hole.addColorStop(1, '#101418');
      g.beginPath();
      g.arc(cx, cy, pr, 0, TAU);
      g.fill();
      g.beginPath();
      g.arc(cx, cy, pr, 0, TAU);
      g.lineWidth = Math.max(2, view.m(0.008));
      g.strokeStyle = 'rgba(0, 0, 0, 0.55)';
      g.stroke();
    }

    // jaw horns (tiny 1.5 mm arcs — draw slightly larger for visibility)
    g.fillStyle = c.jaw;
    for (const seg of t.circular_segments) {
      const cx = view.cx(seg.center[1], seg.center[0]);
      const cy = view.cy(seg.center[1], seg.center[0]);
      g.beginPath();
      g.arc(cx, cy, view.m(0.004), 0, TAU);
      g.fill();
    }

    // --- sights (diamonds) on the wood ---
    g.fillStyle = SIGHT;
    const mid = view.m(cw + wood * 0.5);
    for (let i = 1; i < 8; i++) {
      if (i === 4) continue;                 // side pocket
      const cx = view.cx((i / 8) * t.l, t.w / 2);
      const cy = view.cy((i / 8) * t.l, t.w / 2);
      drawDiamond(g, cx, cy - mid, view.m(0.011));   // top rail
      drawDiamond(g, cx, cy + mid, view.m(0.011));   // bottom rail
    }
    for (let i = 1; i < 4; i++) {
      const cx0 = view.cx(0, (i / 4) * t.w);
      const cy0 = view.cy(0, (i / 4) * t.w);
      drawDiamond(g, cx0 - mid, cy0, view.m(0.011)); // left short rail
      const cx1 = view.cx(t.l, (i / 4) * t.w);
      const cy1 = view.cy(t.l, (i / 4) * t.w);
      drawDiamond(g, cx1 + mid, cy1, view.m(0.011)); // right short rail
    }

    this.layer = layer;
  }

  // ----- dynamic scene --------------------------------------------------------

  draw(scene, view) {
    const g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.layer) g.drawImage(this.layer, 0, 0);
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    if (scene.pocketFlashes) this.drawFlashes(g, scene, view);
    if (scene.trailsOn && scene.trails) this.drawTrails(g, scene, view);
    if (scene.ripples && scene.ripples.length) this.drawRipples(g, scene, view);

    for (const b of scene.balls) {
      if (b.hidden) continue;
      this.drawBall(g, view, b, scene);
    }

    if (scene.aim) this.drawAim(g, scene, view);
    if (scene.assist && !scene.playing) this.drawAssist(g, scene, view);
  }

  drawBall(g, view, b, scene) {
    const cx = view.cx(b.xy[1], b.xy[0]);
    const cy = view.cy(b.xy[1], b.xy[0]);
    const r = view.m(b.radius) * (b.scale ?? 1);
    g.save();
    g.globalAlpha = b.alpha ?? 1;

    // shadow
    g.beginPath();
    g.ellipse(cx + r * 0.18, cy + r * 0.28, r * 1.02, r * 0.92, 0, 0, TAU);
    g.fillStyle = 'rgba(0, 0, 0, 0.35)';
    g.fill();

    // body
    const grad = g.createRadialGradient(cx - r * 0.4, cy - r * 0.45, r * 0.1, cx, cy, r * 1.05);
    if (b.id === 'cue') {
      grad.addColorStop(0, '#fbe28a');
      grad.addColorStop(0.55, '#f2c94c');
      grad.addColorStop(1, '#b98f1e');
    } else {
      grad.addColorStop(0, '#fffdf4');
      grad.addColorStop(0.6, '#f0e9d6');
      grad.addColorStop(1, '#b9b09a');
    }
    g.beginPath();
    g.arc(cx, cy, r, 0, TAU);
    g.fillStyle = grad;
    g.fill();
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(0, 0, 0, 0.28)';
    g.stroke();

    // number badge
    if (b.id !== 'cue' && r > 7) {
      const nr = r * 0.44;
      g.beginPath();
      g.arc(cx, cy, nr, 0, TAU);
      g.fillStyle = 'rgba(255, 255, 255, 0.92)';
      g.fill();
      g.fillStyle = '#26221a';
      g.font = `600 ${Math.max(8, r * 0.52)}px -apple-system, system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(b.id, cx, cy + r * 0.02);
    }

    g.restore();
  }

  drawAim(g, scene, view) {
    const { cue, lineEnd, showLine } = scene.aim;
    if (!cue) return;

    // cue line
    if (showLine !== false && lineEnd) {
      g.save();
      g.setLineDash([view.m(0.05), view.m(0.035)]);
      g.strokeStyle = 'rgba(255, 255, 255, 0.75)';
      g.lineWidth = Math.max(1.2, view.m(0.004));
      g.beginPath();
      g.moveTo(view.cx(cue[1], cue[0]), view.cy(cue[1], cue[0]));
      g.lineTo(view.cx(lineEnd[1], lineEnd[0]), view.cy(lineEnd[1], lineEnd[0]));
      g.stroke();
      g.restore();
    }

    // cue stick
    const stick = scene.aim.stick;
    if (stick) {
      const { tip, butt } = stick;
      g.save();
      g.lineCap = 'round';
      g.strokeStyle = '#e9e4d4';
      g.lineWidth = Math.max(2.5, view.m(0.006));
      g.beginPath();
      g.moveTo(view.cx(tip[1], tip[0]), view.cy(tip[1], tip[0]));
      g.lineTo(view.cx(tip[1] + (butt[1] - tip[1]) * 0.06, tip[0] + (butt[0] - tip[0]) * 0.06),
               view.cy(tip[1] + (butt[1] - tip[1]) * 0.06, tip[0] + (butt[0] - tip[0]) * 0.06));
      g.stroke();

      const sg = g.createLinearGradient(view.cx(tip[1], tip[0]), view.cy(tip[1], tip[0]),
                                        view.cx(butt[1], butt[0]), view.cy(butt[1], butt[0]));
      sg.addColorStop(0, '#8a5a2b');
      sg.addColorStop(0.75, '#5c3a19');
      sg.addColorStop(1, '#1d1410');
      g.strokeStyle = sg;
      g.lineWidth = Math.max(4, view.m(0.009));
      g.beginPath();
      g.moveTo(view.cx(tip[1], tip[0]), view.cy(tip[1], tip[0]));
      g.lineTo(view.cx(butt[1], butt[0]), view.cy(butt[1], butt[0]));
      g.stroke();
      g.restore();
    }
  }

  drawAssist(g, scene, view) {
    const paths = scene.assist;
    if (!paths) return;
    g.save();
    g.lineWidth = Math.max(1.4, view.m(0.0035));
    for (const [id, path] of Object.entries(paths)) {
      const pts = path.xyz;
      if (!pts || pts.length < 2) continue;
      g.strokeStyle = id === 'cue' ? 'rgba(242, 201, 76, 0.6)' : 'rgba(255, 255, 255, 0.42)';
      g.setLineDash(id === 'cue' ? [] : [6, 6]);
      g.beginPath();
      g.moveTo(view.cx(pts[0][1], pts[0][0]), view.cy(pts[0][1], pts[0][0]));
      for (let i = 1; i < pts.length; i++) {
        g.lineTo(view.cx(pts[i][1], pts[i][0]), view.cy(pts[i][1], pts[i][0]));
      }
      g.stroke();
    }
    g.restore();
  }

  drawTrails(g, scene, view) {
    for (const [id, pts] of Object.entries(scene.trails || {})) {
      if (pts.length < 2) continue;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const alpha = (i / pts.length) * 0.35;
        g.strokeStyle = id === 'cue'
          ? `rgba(242, 201, 76, ${alpha})`
          : `rgba(255, 255, 255, ${alpha * 0.8})`;
        g.lineWidth = Math.max(1.5, view.m(0.006));
        g.beginPath();
        g.moveTo(view.cx(a[1], a[0]), view.cy(a[1], a[0]));
        g.lineTo(view.cx(b[1], b[0]), view.cy(b[1], b[0]));
        g.stroke();
      }
    }
  }

  drawRipples(g, scene, view) {
    const now = scene.now;
    for (const rp of scene.ripples) {
      const age = (now - rp.t0) / 0.6;
      if (age < 0 || age > 1) continue;
      g.beginPath();
      g.arc(view.cx(rp.xy[1], rp.xy[0]), view.cy(rp.xy[1], rp.xy[0]),
            view.m(0.02 + age * 0.07), 0, TAU);
      g.strokeStyle = rp.kind === 'ball_ball'
        ? `rgba(242, 201, 76, ${(1 - age) * 0.7})`
        : `rgba(255, 255, 255, ${(1 - age) * 0.4})`;
      g.lineWidth = 2;
      g.stroke();
    }
  }

  drawFlashes(g, scene, view) {
    const now = scene.now;
    for (const pf of scene.pocketFlashes) {
      const age = (now - pf.t0) / 0.7;
      if (age < 0 || age > 1) continue;
      g.beginPath();
      g.arc(view.cx(pf.xy[1], pf.xy[0]), view.cy(pf.xy[1], pf.xy[0]),
            view.m(0.055) * (1 - age * 0.3), 0, TAU);
      g.strokeStyle = `rgba(212, 165, 55, ${(1 - age) * 0.9})`;
      g.lineWidth = 3;
      g.stroke();
    }
  }
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function drawDiamond(g, x, y, r) {
  g.beginPath();
  g.moveTo(x, y - r);
  g.lineTo(x + r, y);
  g.lineTo(x, y + r);
  g.lineTo(x - r, y);
  g.closePath();
  g.fill();
}
