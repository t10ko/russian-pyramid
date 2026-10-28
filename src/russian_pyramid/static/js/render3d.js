// WebGL renderer (three.js): builds the table from the same physics
// geometry the solver uses, renders balls/cue/overlays in 3D, and provides
// cloth-plane picking so aiming works like in the 2D view.
//
// World mapping: table (x, y, z-up) -> world (x, z, y).  Table y=0 (the
// head end) faces the default camera, matching the vertical layout.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const WOOD_COLOR = 0x4a2f1d;
const WOOD_DARK = 0x33200f;
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
    this.controls.target.set(table.w / 2, 0, table.l * 0.52);

    this._lights(table);
    this._table(table);
    this._overlayGroups();

    this._raycaster = new THREE.Raycaster();
    this._pickPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -ballR);
    this._ndc = new THREE.Vector2();
    this._pickOut = new THREE.Vector3();

    this._ballMeshes = new Map();
    this._textures = new Map();
    this.setCamera('tv');
  }

  // ---------- static scene ----------------------------------------------------

  _lights(table) {
    const hemi = new THREE.HemisphereLight(0xfff6e0, 0x1c2b22, 0.85);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffffff, 1.7);
    key.position.set(table.w / 2 + 1.6, 3.4, table.l / 2 - 1.4);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const s = 2.6;
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

    // slate base + wood frame (single slab, top just under cloth level)
    const fw = t.w + 2 * (t.cushion_width + 0.085);
    const fl = t.l + 2 * (t.cushion_width + 0.085);
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(fw, 0.05, fl),
      new THREE.MeshStandardMaterial({ color: WOOD_COLOR, roughness: 0.55, metalness: 0.08 }),
    );
    slab.position.set(t.w / 2, 0.055 - 0.025, t.l / 2);
    slab.receiveShadow = true;
    g.add(slab);

    // darker outer rim
    const rim = new THREE.Mesh(
      new THREE.BoxGeometry(fw + 0.02, 0.012, fl + 0.02),
      new THREE.MeshStandardMaterial({ color: WOOD_DARK, roughness: 0.7 }),
    );
    rim.position.set(t.w / 2, 0.028, t.l / 2);
    g.add(rim);

    // cloth
    const felt = new THREE.Mesh(
      new THREE.BoxGeometry(t.w, 0.012, t.l),
      new THREE.MeshStandardMaterial({ color: cloth.felt, roughness: 0.95 }),
    );
    felt.position.set(t.w / 2, 0.056, t.l / 2);
    felt.receiveShadow = true;
    g.add(felt);

    // cushions: a box per physics segment, placed on the outer side
    const ch = 0.043;
    const cmat = new THREE.MeshStandardMaterial({
      color: cloth.cushion, roughness: 0.9,
    });
    const cx = t.w / 2, cy = t.l / 2;
    for (const seg of t.linear_segments) {
      const p1 = seg.p1, p2 = seg.p2;
      const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
      const mx = (p1[0] + p2[0]) / 2, my = (p1[1] + p2[1]) / 2;
      // outward = away from table center (segments are axis-aligned here)
      const dx = Math.abs(mx - cx) > Math.abs(my - cy)
        ? Math.sign(mx - cx) : 0;
      const dy = dx === 0 ? Math.sign(my - cy) : 0;
      const off = t.cushion_width / 2;
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(
          dx !== 0 ? t.cushion_width : len,
          ch,
          dy !== 0 ? t.cushion_width : len),
        cmat,
      );
      box.position.set(mx + dx * off, 0.06 + ch / 2 - 0.012, my + dy * off);
      box.castShadow = true;
      box.receiveShadow = true;
      g.add(box);
    }

    // jaw horns
    const jmat = new THREE.MeshStandardMaterial({
      color: cloth.cushion, roughness: 0.85,
    });
    for (const seg of t.circular_segments) {
      const jaw = new THREE.Mesh(
        new THREE.CylinderGeometry(Math.max(seg.radius, 0.004),
                                    Math.max(seg.radius, 0.004), ch, 12),
        jmat,
      );
      jaw.position.set(seg.center[0], 0.06 + ch / 2 - 0.012, seg.center[1]);
      jaw.castShadow = true;
      g.add(jaw);
    }

    // pockets: dark cups that read as holes in the frame
    for (const p of t.pockets) {
      const cup = new THREE.Mesh(
        new THREE.CylinderGeometry(p.radius * 0.98, p.radius * 0.8, 0.11, 28, 1, true),
        new THREE.MeshStandardMaterial({ color: 0x05070a, roughness: 1, side: THREE.DoubleSide }),
      );
      cup.position.set(p.center[0], 0.06, p.center[1]);
      g.add(cup);
      const bottom = new THREE.Mesh(
        new THREE.CircleGeometry(p.radius * 0.9, 24),
        new THREE.MeshStandardMaterial({ color: 0x020304 }),
      );
      bottom.rotation.x = -Math.PI / 2;
      bottom.position.set(p.center[0], 0.008, p.center[1]);
      g.add(bottom);
    }

    // sights (diamonds)
    const dmat = new THREE.MeshStandardMaterial({
      color: 0xe8dcc0, roughness: 0.35, metalness: 0.2,
    });
    const sight = (x, y) => {
      const d = new THREE.Mesh(new THREE.CircleGeometry(0.010, 4), dmat);
      d.rotation.x = -Math.PI / 2;
      d.rotation.z = Math.PI / 4;
      d.position.set(x, 0.083, y);
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

    // aim line
    this.aimLine = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.045, gapSize: 0.03 }),
    );
    this.aimGroup.add(this.aimLine);

    // ghost ball
    this.ghostBall = new THREE.Mesh(
      new THREE.SphereGeometry(this.ballR, 20, 14),
      new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.55 }),
    );
    this.aimGroup.add(this.ghostBall);

    // object-ball direction arrow
    this.objArrow = new THREE.ArrowHelper(
      new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 0.3, 0xd4a537, 0.05, 0.03);
    this.aimGroup.add(this.objArrow);

    // cue stick
    this.stick = buildCueStick();
    this.aimGroup.add(this.stick);
  }

  // ---------- camera ------------------------------------------------------

  setCamera(preset) {
    this.preset = preset;
    const { w, l } = this._dims;
    if (preset === 'top') {
      this.camera.position.set(w / 2 + 0.0001, 3.6, l / 2);
      this.controls.target.set(w / 2, 0, l / 2);
    } else {  // 'tv': behind the head rail, looking up-table
      this.camera.position.set(w / 2 + 0.02, 1.6, -1.05);
      this.controls.target.set(w / 2, 0.02, l * 0.55);
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
      mesh.position.set(b.xy[0], Math.max(z, -0.08), b.xy[1]);
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
      for (const cx of [64, 192]) {
        g.beginPath();
        g.arc(cx, 64, 26, 0, Math.PI * 2);
        g.fillStyle = '#fffdf4';
        g.fill();
        g.strokeStyle = '#c9c2ad';
        g.lineWidth = 2;
        g.stroke();
        g.fillStyle = '#26221a';
        g.font = '600 30px system-ui, sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(String(id), cx, 65);
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

    const zA = ballR;
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
      this.objArrow.position.set(ghost[0], 0.004, ghost[1]);
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
      const verts = pts.map((p) => new THREE.Vector3(p[0], (p[2] || 0) + 0.004, p[1]));
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
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        verts.push(new THREE.Vector3(p[0], (p[2] || this.ballR) + 0.002, p[1]));
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
      mesh.position.set(r.xy[0], 0.065, r.xy[1]);
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
