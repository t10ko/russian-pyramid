// WebGL renderer (three.js): builds the table from the same physics
// geometry the solver uses, renders balls/cue/overlays in 3D, and provides
// cloth-plane picking so aiming works like in the 2D view.
//
// World mapping: table (x, y, z-up) -> world (x, Y0 + z, y).  Y0 is the
// height of the playing surface: pooltool measures z from the cloth, while
// the built table geometry lifts the cloth to world y = Y0.  Forgetting the
// offset sinks the balls and cue into the table.
//
// Table y=0 (the head end) faces the default camera, matching the vertical
// layout.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const Y0 = 0.062;             // world height of the cloth surface
const CUSHION_H = 0.043;
const WOOD_TOP = 0.055;       // top of the wood slab (just under the cloth)
const WOOD_COLOR = 0x4a2f1d;
const LEATHER = 0x3a2417;
const CLOTHS = {
  green: { felt: 0x0d7048, cushion: 0x0a6140 },
  blue: { felt: 0x1362a0, cushion: 0x10578c },
  red: { felt: 0x9c3038, cushion: 0x8a2a31 },
};

export class Renderer3D {
  constructor(canvas, table, ballR) {
    this.canvas = canvas;
    this.ballR = ballR;
    this.cloth = 'green';
    this.preset = 'tv';

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0e1216);

    this.camera = new THREE.PerspectiveCamera(42, 1.6, 0.05, 60);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 0.6;
    this.controls.maxDistance = 7;
    // right button stays free for ball removal in place mode
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: null,
    };
    this.controls.target.set(table.w / 2, Y0, table.l * 0.52);

    this._lights(table);
    this._table(table);
    this._markings(table);
    this._overlayGroups();

    this._raycaster = new THREE.Raycaster();
    this._pickPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -(Y0 + ballR));
    this._ndc = new THREE.Vector2();
    this._pickOut = new THREE.Vector3();

    this._ballMeshes = new Map();
    this._textures = new Map();
    this.setCamera('tv');
  }

  // Enable/disable camera orbiting (main.js toggles it for Shift=cue mode
  // and while dragging balls).
  setInteractive(enabled) {
    this.controls.enabled = !!enabled;
  }

  // ---------- static scene ----------------------------------------------------

  _lights(table) {
    const hemi = new THREE.HemisphereLight(0xfff6e0, 0x1c2b22, 0.85);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffffff, 1.7);
    key.position.set(table.w / 2 + 1.6, 3.4, table.l / 2 - 1.4);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const s = 3.0;
    key.shadow.camera.left = -s;
    key.shadow.camera.right = s;
    key.shadow.camera.top = s;
    key.shadow.camera.bottom = -s;
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 9;
    key.shadow.bias = -0.0005;
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xdfe8ff, 0.35);
    fill.position.set(-1.2, 2.2, table.l + 1.0);
    this.scene.add(fill);
  }

  _table(t) {
    this._dims = { w: t.w, l: t.l };
    const g = new THREE.Group();
    const cloth = CLOTHS[this.cloth];

    // wood slab + cloth: slab top at WOOD_TOP, cloth box on top, surface at Y0
    const fw = t.w + 2 * (t.cushion_width + 0.085);
    const fl = t.l + 2 * (t.cushion_width + 0.085);
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(fw, WOOD_TOP - 0.005, fl),
      new THREE.MeshStandardMaterial({ color: WOOD_COLOR, roughness: 0.55, metalness: 0.08 }),
    );
    slab.position.set(t.w / 2, (WOOD_TOP - 0.005) / 2 + 0.005, t.l / 2);
    slab.receiveShadow = true;
    g.add(slab);

    const felt = new THREE.Mesh(
      new THREE.BoxGeometry(t.w, Y0 - WOOD_TOP, t.l),
      new THREE.MeshStandardMaterial({ color: cloth.felt, roughness: 0.95 }),
    );
    felt.position.set(t.w / 2, (Y0 + WOOD_TOP) / 2, t.l / 2);
    felt.receiveShadow = true;
    g.add(felt);

    // cushions: a box per physics segment, placed on the outer side
    const cmat = new THREE.MeshStandardMaterial({ color: cloth.cushion, roughness: 0.9 });
    const cx = t.w / 2, cy = t.l / 2;
    for (const seg of t.linear_segments) {
      const p1 = seg.p1, p2 = seg.p2;
      const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
      const mx = (p1[0] + p2[0]) / 2, my = (p1[1] + p2[1]) / 2;
      const dx = Math.abs(mx - cx) > Math.abs(my - cy) ? Math.sign(mx - cx) : 0;
      const dy = dx === 0 ? Math.sign(my - cy) : 0;
      const off = t.cushion_width / 2;
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(
          dx !== 0 ? t.cushion_width : len,
          CUSHION_H,
          dy !== 0 ? t.cushion_width : len),
        cmat,
      );
      box.position.set(mx + dx * off, Y0 + CUSHION_H / 2 - 0.004, my + dy * off);
      box.castShadow = true;
      box.receiveShadow = true;
      g.add(box);
    }

    // jaw caps: leather horns where the cushions end
    const jmat = new THREE.MeshStandardMaterial({ color: LEATHER, roughness: 0.75 });
    for (const seg of t.circular_segments) {
      const jaw = new THREE.Mesh(
        new THREE.CylinderGeometry(Math.max(seg.radius, 0.006),
                                    Math.max(seg.radius, 0.006), CUSHION_H, 12),
        jmat,
      );
      jaw.position.set(seg.center[0], Y0 + CUSHION_H / 2 - 0.004, seg.center[1]);
      jaw.castShadow = true;
      g.add(jaw);
    }

    // pockets: recessed hole + leather rim (NOT a cylinder sticking up)
    const rimMat = new THREE.MeshStandardMaterial({
      color: LEATHER, roughness: 0.7, metalness: 0.05,
    });
    const holeMat = new THREE.MeshStandardMaterial({
      color: 0x060504, roughness: 1, side: THREE.DoubleSide,
    });
    for (const p of t.pockets) {
      const rim = new THREE.Mesh(
        new THREE.RingGeometry(p.radius * 0.92, p.radius * 1.32, 36),
        rimMat,
      );
      rim.rotation.x = -Math.PI / 2;
      rim.position.set(p.center[0], Y0 + 0.0008, p.center[1]);
      g.add(rim);

      const wall = new THREE.Mesh(
        new THREE.CylinderGeometry(p.radius * 0.94, p.radius * 0.78, 0.06, 30, 1, true),
        holeMat,
      );
      wall.position.set(p.center[0], Y0 - 0.03, p.center[1]);
      g.add(wall);

      const bottom = new THREE.Mesh(
        new THREE.CircleGeometry(p.radius * 0.85, 28),
        new THREE.MeshStandardMaterial({ color: 0x020202 }),
      );
      bottom.rotation.x = -Math.PI / 2;
      bottom.position.set(p.center[0], Y0 - 0.058, p.center[1]);
      g.add(bottom);
    }

    // sights (diamonds) on the wood, level with the slab top
    const dmat = new THREE.MeshStandardMaterial({
      color: 0xe8dcc0, roughness: 0.35, metalness: 0.2,
    });
    const sight = (x, y) => {
      const d = new THREE.Mesh(new THREE.CircleGeometry(0.010, 4), dmat);
      d.rotation.x = -Math.PI / 2;
      d.rotation.z = Math.PI / 4;
      d.position.set(x, WOOD_TOP + 0.0006, y);
      g.add(d);
    };
    for (let i = 1; i < 8; i++) {
      if (i === 4) continue;
      const y = (i / 8) * t.l;
      const off = t.cushion_width + 0.045;
      sight(0 - off, y);
      sight(t.w + off, y);
    }
    for (let i = 1; i < 4; i++) {
      const x = (i / 4) * t.w;
      const off = t.cushion_width + 0.045;
      sight(x, 0 - off);
      sight(x, t.l + off);
    }

    this.tableGroup = g;
    this.scene.add(g);
  }

  // Head string, spots, and the rack triangle (dashed), like the real cloth.
  _markings(t) {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.22, depthWrite: false,
    });

    const bar = (x0, y0, x1, y1, width = 0.003, opacity = 0.22) => {
      const len = Math.hypot(x1 - x0, y1 - y0);
      const m = mat.clone();
      m.opacity = opacity;
      const b = new THREE.Mesh(new THREE.BoxGeometry(len, 0.0006, width), m);
      b.position.set((x0 + x1) / 2, Y0 + 0.0012, (y0 + y1) / 2);
      b.rotation.y = -Math.atan2(y1 - y0, x1 - x0);
      g.add(b);
      return b;
    };

    const cx = t.w / 2;
    const yHead = t.l / 4, yFoot = (3 * t.l) / 4;

    // head string (the "house" line the cue ball starts behind)
    bar(0.06, yHead, t.w - 0.06, yHead, 0.0035, 0.28);

    // spots: head, center, foot
    const spotMat = mat.clone();
    spotMat.opacity = 0.4;
    for (const sy of [yHead, t.l / 2, yFoot]) {
      const s = new THREE.Mesh(new THREE.CircleGeometry(0.009, 20), spotMat);
      s.rotation.x = -Math.PI / 2;
      s.position.set(cx, Y0 + 0.0012, sy);
      g.add(s);
    }

    // rack triangle: apex on the foot spot, opening toward the foot rail
    const gap = 2 * 0.034 + 0.0006;
    const h = 4 * gap * Math.sin(Math.PI / 3);
    const half = 2 * gap;
    const ax = cx, ay = yFoot;
    const bx = cx - half, by = yFoot + h;
    const cx2 = cx + half, cy2 = yFoot + h;
    dashLine(g, mat, [ax, ay], [bx, by], 0.0028, 0.3);
    dashLine(g, mat, [ax, ay], [cx2, cy2], 0.0028, 0.3);
    dashLine(g, mat, [bx, by], [cx2, cy2], 0.0028, 0.3);

    this.markingsGroup = g;
    this.scene.add(g);
  }

  _overlayGroups() {
    this.ballGroup = new THREE.Group();
    this.scene.add(this.ballGroup);

    this.aimGroup = new THREE.Group();
    this.scene.add(this.aimGroup);

    this.assistGroup = new THREE.Group();
    this.scene.add(this.assistGroup);

    this.trailGroup = new THREE.Group();
    this.scene.add(this.trailGroup);

    this.fxGroup = new THREE.Group();
    this.scene.add(this.fxGroup);

    this.aimLine = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.045, gapSize: 0.03 }),
    );
    this.aimGroup.add(this.aimLine);

    this.ghostBall = new THREE.Mesh(
      new THREE.SphereGeometry(this.ballR, 20, 14),
      new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.55 }),
    );
    this.aimGroup.add(this.ghostBall);

    this.objArrow = new THREE.ArrowHelper(
      new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 0.3, 0xd4a537, 0.05, 0.03);
    this.aimGroup.add(this.objArrow);

    this.stick = buildCueStick();
    this.aimGroup.add(this.stick);
  }

  // ---------- camera ------------------------------------------------------

  setCamera(preset) {
    this.preset = preset;
    const { w, l } = this._dims;
    if (preset === 'top') {
      this.camera.position.set(w / 2 + 0.0001, Y0 + 3.6, l / 2);
      this.controls.target.set(w / 2, Y0, l / 2);
    } else {  // 'tv': behind the head rail, looking up-table
      this.camera.position.set(w / 2 + 0.02, Y0 + 1.6, -1.05);
      this.controls.target.set(w / 2, Y0 + 0.02, l * 0.55);
    }
    this.controls.update();
  }

  // ---------- frame -------------------------------------------------------

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    this.renderer.setSize(rect.width, rect.height, false);
    this.camera.aspect = rect.width / rect.height;
    this.camera.updateProjectionMatrix();
  }

  draw(scene) {
    this._syncBalls(scene.balls);
    this._syncAim(scene);
    this._syncAssist(scene.assist);
    this._syncTrails(scene);
    this._syncFx(scene);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  _syncBalls(balls) {
    const seen = new Set();
    for (const b of balls) {
      if (b.hidden) continue;
      seen.add(b.id);
      let mesh = this._ballMeshes.get(b.id);
      if (!mesh) {
        mesh = new THREE.Mesh(
          new THREE.SphereGeometry(this.ballR, 32, 24),
          new THREE.MeshStandardMaterial({
            map: this._ballTexture(b.id, b.isCue),
            roughness: 0.18, metalness: 0.05,
          }),
        );
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this._ballMeshes.set(b.id, mesh);
        this.ballGroup.add(mesh);
      }
      const z = (b.z ?? this.ballR);
      mesh.position.set(b.xy[0], Y0 + Math.max(z, -0.1), b.xy[1]);
      mesh.scale.setScalar(b.scale ?? 1);
      mesh.material.opacity = b.alpha ?? 1;
      mesh.material.transparent = (b.alpha ?? 1) < 0.999;
    }
    for (const [id, mesh] of this._ballMeshes) {
      if (!seen.has(id)) {
        this.ballGroup.remove(mesh);
        this._ballMeshes.delete(id);
      }
    }
  }

  _ballTexture(id, isCue) {
    if (this._textures.has(id)) return this._textures.get(id);
    const c = document.createElement('canvas');
    c.width = 256; c.height = 128;
    const g = c.getContext('2d');
    if (isCue) {
      g.fillStyle = '#f2c94c';
      g.fillRect(0, 0, 256, 128);
      const grad = g.createLinearGradient(0, 0, 256, 0);
      grad.addColorStop(0, 'rgba(255,255,255,0.25)');
      grad.addColorStop(0.5, 'rgba(0,0,0,0)');
      grad.addColorStop(1, 'rgba(0,0,0,0.18)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 256, 128);
    } else {
      g.fillStyle = '#f5efe0';
      g.fillRect(0, 0, 256, 128);
      for (const bx of [64, 192]) {
        g.beginPath();
        g.arc(bx, 64, 26, 0, Math.PI * 2);
        g.fillStyle = '#fffdf4';
        g.fill();
        g.strokeStyle = '#c9c2ad';
        g.lineWidth = 2;
        g.stroke();
        g.fillStyle = '#26221a';
        g.font = '600 30px system-ui, sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(String(id), bx, 65);
      }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this._textures.set(id, tex);
    return tex;
  }

  _syncAim(scene) {
    const aim = scene.aim;
    const show = !!aim;
    this.aimGroup.visible = show;
    if (!show) return;

    const { cue, lineEnd, ghost, objDir, stick, ballR } = aim;

    const zA = Y0 + ballR;
    this.aimLine.geometry.setFromPoints([
      new THREE.Vector3(cue[0], zA, cue[1]),
      new THREE.Vector3(lineEnd[0], zA, lineEnd[1]),
    ]);
    this.aimLine.computeLineDistances();

    const showGhost = aim.showGhost && ghost;
    this.ghostBall.visible = !!showGhost;
    if (showGhost) {
      this.ghostBall.position.set(ghost[0], zA, ghost[1]);
    }

    this.objArrow.visible = !!(showGhost && objDir);
    if (objDir && showGhost) {
      this.objArrow.position.set(ghost[0], Y0 + 0.004, ghost[1]);
      this.objArrow.setDirection(new THREE.Vector3(objDir[0], 0, objDir[1]));
      this.objArrow.setLength(0.3, 0.05, 0.028);
    }

    // stick: tip/butt are table-plane points; raise the butt with theta
    const theta = (aim.theta ?? 0) * Math.PI / 180;
    const tip = new THREE.Vector3(stick.tip[0], zA, stick.tip[1]);
    const butt = new THREE.Vector3(stick.butt[0], zA, stick.butt[1]);
    const len = tip.distanceTo(butt) || 1;
    butt.y += Math.sin(theta) * len;
    tip.y += Math.sin(theta) * 0.04;

    const mid = tip.clone().lerp(butt, 0.5);
    const dir = tip.clone().sub(butt).normalize();   // butt -> tip (+Y local)
    this.stick.position.copy(mid);
    this.stick.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  }

  _syncAssist(paths) {
    this.assistGroup.clear();
    if (!paths) return;
    for (const [id, path] of Object.entries(paths)) {
      const pts = path.xyz;
      if (!pts || pts.length < 2) continue;
      const verts = pts.map((p) => new THREE.Vector3(p[0], Y0 + (p[2] || 0) + 0.004, p[1]));
      const geo = new THREE.BufferGeometry().setFromPoints(verts);
      const mat = id === 'cue'
        ? new THREE.LineBasicMaterial({ color: 0xf2c94c, transparent: true, opacity: 0.65 })
        : new THREE.LineDashedMaterial({ color: 0xffffff, transparent: true, opacity: 0.4,
                                         dashSize: 0.05, gapSize: 0.04 });
      const line = new THREE.Line(geo, mat);
      if (mat.isLineDashedMaterial) line.computeLineDistances();
      this.assistGroup.add(line);
    }
  }

  _syncTrails(scene) {
    this.trailGroup.clear();
    if (!scene.trailsOn || !scene.trails) return;
    for (const [id, pts] of Object.entries(scene.trails)) {
      if (pts.length < 2) continue;
      const verts = [];
      for (const p of pts) {
        verts.push(new THREE.Vector3(p[0], Y0 + (p[2] ?? this.ballR) + 0.002, p[1]));
      }
      const geo = new THREE.BufferGeometry().setFromPoints(verts);
      const mat = new THREE.LineBasicMaterial({
        color: id === 'cue' ? 0xf2c94c : 0xdde5e8,
        transparent: true, opacity: 0.4,
      });
      this.trailGroup.add(new THREE.Line(geo, mat));
    }
  }

  _syncFx(scene) {
    this.fxGroup.clear();
    const now = scene.now ?? 0;
    const rings = [];
    for (const rp of scene.ripples || []) {
      const age = (now - rp.t0) / 0.6;
      if (age < 0 || age > 1) continue;
      rings.push({ xy: rp.xy, age, color: rp.kind === 'ball_ball' ? 0xf2c94c : 0xffffff,
                   max: 0.09, alpha: 0.7 });
    }
    for (const pf of scene.pocketFlashes || []) {
      const age = (now - pf.t0) / 0.7;
      if (age < 0 || age > 1) continue;
      rings.push({ xy: pf.xy, age, color: 0xd4a537, max: 0.075, alpha: 0.9 });
    }
    for (const r of rings) {
      const mesh = new THREE.Mesh(
        new THREE.RingGeometry(0.02 + r.age * r.max * 0.7, 0.026 + r.age * r.max, 32),
        new THREE.MeshBasicMaterial({ color: r.color, transparent: true,
                                      opacity: (1 - r.age) * r.alpha, side: THREE.DoubleSide }),
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(r.xy[0], Y0 + 0.004, r.xy[1]);
      this.fxGroup.add(mesh);
    }
  }

  // ---------- picking -------------------------------------------------------

  // pointer (canvas-relative px) -> table (x, y) on the ball-center plane
  tableFromClient(px, py) {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 2) return null;
    this._ndc.set((px / rect.width) * 2 - 1, -(py / rect.height) * 2 + 1);
    this._raycaster.setFromCamera(this._ndc, this.camera);
    const hit = this._raycaster.ray.intersectPlane(this._pickPlane, this._pickOut);
    return hit ? [this._pickOut.x, this._pickOut.z] : null;
  }
}

// Dashed line built from short flat boxes (used for the rack triangle).
function dashLine(group, mat, a, b, width, opacity) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.max(2, Math.round(len / 0.05));
  const dash = 0.026, gap = 0.024;
  const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
  const ang = -Math.atan2(b[1] - a[1], b[0] - a[0]);
  let t = 0;
  while (t < len) {
    const segLen = Math.min(dash, len - t);
    const m = mat.clone();
    m.opacity = opacity;
    const box = new THREE.Mesh(new THREE.BoxGeometry(segLen, 0.0006, width), m);
    box.position.set(a[0] + ux * (t + segLen / 2), Y0 + 0.0014, a[1] + uy * (t + segLen / 2));
    box.rotation.y = ang;
    group.add(box);
    t += dash + gap;
  }
}

function buildCueStick() {
  const group = new THREE.Group();
  const shaftLen = 1.30, tipLen = 0.05, buttLen = 0.10;

  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.006, 0.012, shaftLen, 12),
    new THREE.MeshStandardMaterial({ color: 0x8a5a2b, roughness: 0.4 }),
  );
  shaft.position.y = -shaftLen / 2;

  const tip = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0058, 0.006, tipLen, 12),
    new THREE.MeshStandardMaterial({ color: 0xe9e4d4, roughness: 0.6 }),
  );
  tip.position.y = -tipLen / 2;

  const wrap = new THREE.Mesh(
    new THREE.CylinderGeometry(0.012, 0.013, buttLen, 12),
    new THREE.MeshStandardMaterial({ color: 0x1d1410, roughness: 0.5 }),
  );
  wrap.position.y = -shaftLen - buttLen / 2;

  group.add(shaft, tip, wrap);
  return group;
}
