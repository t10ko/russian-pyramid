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
import { POCKET_DIMS, POCKET_WELL_DEPTH, buildPocketSpecs } from './geometry.js';

const Y0 = 0.062;             // world height of the cloth surface
const CUSHION_H = 0.043;
const WOOD_TOP = 0.055;       // top of the slate/bed under the cloth
const WOOD_COLOR = 0x4a2f1d;
const WOOD_DARK = 0x2c1b10;
const LEATHER = 0x2f1c11;
const LEATHER_RIM = 0x3d2416;
const BRASS = 0xc89b3c;
const AIM_COLOR = 0xffd34d;      // cue-ball aim line + ghost-ball footprint
const AIM_DOT_COLOR = 0xffdd00;  // sightline aim point on the target ball
const CONTACT_COLOR = 0xff3b30;  // contact point on the object ball
const TARGET_COLOR = 0x45d4ff;   // predicted path of the first ball touched
const CUE_PATH_COLOR = 0xff5fd2;  // predicted cue-ball path (svoyak when it drops)
const POT_COLOR = 0x3ddc84;       // end ring when the predicted path drops
const AIM_BEAM_R = 0.0011;       // m, radius of the aim / trajectory tubes
const CLOTHS = {
  green: { felt: 0x0d7048, cushion: 0x0a6140, throat: 0x07452c },
  blue: { felt: 0x1362a0, cushion: 0x10578c, throat: 0x0b3d64 },
  red: { felt: 0x9c3038, cushion: 0x8a2a31, throat: 0x5c1b20 },
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
    this.controls.minDistance = 0.45;
    this.controls.maxDistance = 7;
    this.controls.enablePan = true;
    // Pan horizontally across the table surface (XZ plane) without sinking the pivot
    this.controls.screenSpacePanning = false;
    this.controls.panSpeed = 1.0;
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN,
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
    this._camGoal = null;
    this.controls.addEventListener('start', () => { this._camGoal = null; });
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
    const w = t.w, l = t.l, cw = t.cushion_width;
    const wood = 0.085;
    const railTop = Y0 + CUSHION_H;

    // Exact Russian Pyramid mouth & jaw parameters matching pooltool specs:
    // 72.5 mm corner throat (cNose = 0.0725 / √2 = 0.05127 m, 45° jaws, 5 mm rounded noses),
    // 82.0 mm side mouth (sNose with 11 mm rounded noses + 5° splay).
    const { cNose, sNose, sBack } = POCKET_DIMS;
    const cBack = cNose - cw;           // -0.00373: 45° jaw outer corner at distance cw

    const pocketSpecs = buildPocketSpecs(w, l, cw, cNose, cBack, sNose, sBack);

    // 1. Lower wooden frame / slate bed with the 6 pocket holes cut through
    const bedShape = roundedRectShape(-cw - wood, -cw - wood, w + 2 * (cw + wood), l + 2 * (cw + wood), 0.075);
    for (const ps of pocketSpecs) {
      bedShape.holes.push(pocketCutoutPath(ps, 0.001));
    }
    const slab = extrudeTableShape(
      bedShape,
      WOOD_TOP,
      WOOD_TOP - 0.005,
      new THREE.MeshStandardMaterial({ color: WOOD_DARK, roughness: 0.65, metalness: 0.06 }),
    );
    slab.receiveShadow = true;
    g.add(slab);

    // 2. Playing cloth (felt) with the 6 Russian Pyramid pocket cutouts
    // (concave fall-edge / скат лузы between the jaw horns + open throat & well)
    const feltPad = cw + wood * 0.72;
    const feltShape = roundedRectShape(-feltPad, -feltPad, w + 2 * feltPad, l + 2 * feltPad, 0.05);
    for (const ps of pocketSpecs) {
      feltShape.holes.push(pocketCutoutPath(ps, 0));
    }
    const felt = extrudeTableShape(
      feltShape,
      Y0,
      Y0 - WOOD_TOP,
      new THREE.MeshStandardMaterial({ color: cloth.felt, roughness: 0.95 }),
    );
    felt.receiveShadow = true;
    g.add(felt);

    // Subtle beveled cloth lip (скат лузы) around each pocket cutout
    const throatMat = new THREE.MeshStandardMaterial({ color: cloth.throat, roughness: 0.95 });
    for (const ps of pocketSpecs) {
      const lipRing = pocketLipShape(ps);
      const lip = extrudeTableShape(lipRing, Y0 - 0.0004, 0.006, throatMat);
      g.add(lip);
    }

    // 3. Six cloth-covered cushions with rounded Russian Pyramid jaw horns
    // (губки луз) and smooth 45° corner / splayed side jaw walls
    const cmat = new THREE.MeshStandardMaterial({ color: cloth.cushion, roughness: 0.88 });
    const cushionSpecs = buildCushionPolygons(w, l, cw, cNose, cBack, sNose, sBack);
    for (const { pts, radii } of cushionSpecs) {
      const mesh = extrudeTableShape(
        roundedPolyToShape(pts, radii),
        railTop - 0.0035,
        CUSHION_H - 0.0025,
        cmat,
        { bevelEnabled: true, bevelThickness: 0.0035, bevelSize: 0.003, bevelOffset: -0.003, bevelSegments: 4 },
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      g.add(mesh);
    }

    // 4. Six raised wooden rail caps (поручни бортов) behind the cushions,
    // terminating cleanly at the 6 pocket brackets
    const railMat = new THREE.MeshStandardMaterial({
      color: WOOD_COLOR, roughness: 0.48, metalness: 0.08,
    });
    const railPolys = buildWoodenRailPolygons(w, l, cw, wood, cNose, sNose);
    for (const poly of railPolys) {
      const mesh = extrudeTableShape(
        polyToShape(poly),
        railTop - 0.0015,
        CUSHION_H + (Y0 - WOOD_TOP) - 0.001,
        railMat,
        { bevelEnabled: true, bevelThickness: 0.0015, bevelSize: 0.0015, bevelOffset: -0.0015, bevelSegments: 2 },
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      g.add(mesh);
    }

    // 5. Six Russian Pyramid pockets: deep dark well + net basket, leather jaw
    // facings (губы), curved leather apron/hood (пелерина), and brass bracket (скоба)
    const holeMat = new THREE.MeshStandardMaterial({
      color: 0x040303, roughness: 1, side: THREE.DoubleSide,
    });
    const netMat = new THREE.MeshStandardMaterial({
      color: 0x1d130c, roughness: 0.9, side: THREE.DoubleSide,
    });
    const leatherMat = new THREE.MeshStandardMaterial({
      color: LEATHER, roughness: 0.58, metalness: 0.05,
    });
    const leatherRimMat = new THREE.MeshStandardMaterial({
      color: LEATHER_RIM, roughness: 0.52, metalness: 0.06,
    });
    const brassMat = new THREE.MeshStandardMaterial({
      color: BRASS, roughness: 0.30, metalness: 0.75,
    });

    for (const ps of pocketSpecs) {
      buildRussianPocket(g, ps, railTop, {
        holeMat, netMat, leatherMat, leatherRimMat, brassMat,
      });
    }

    // 6. Diamond sights inlaid flush on top of the wooden rails
    const dmat = new THREE.MeshStandardMaterial({
      color: 0xe8dcc0, roughness: 0.35, metalness: 0.2,
    });
    const sight = (x, y) => {
      const d = new THREE.Mesh(new THREE.CircleGeometry(0.010, 4), dmat);
      d.rotation.x = -Math.PI / 2;
      d.rotation.z = Math.PI / 4;
      d.position.set(x, railTop + 0.0006, y);
      g.add(d);
    };
    for (let i = 1; i < 8; i++) {
      if (i === 4) continue;
      const y = (i / 8) * t.l;
      const off = t.cushion_width + 0.042;
      sight(0 - off, y);
      sight(t.w + off, y);
    }
    for (let i = 1; i < 4; i++) {
      const x = (i / 4) * t.w;
      const off = t.cushion_width + 0.042;
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

    this.markingsGroup = g;
    this.scene.add(g);
  }

  _overlayGroups() {
    this.ballGroup = new THREE.Group();
    this.scene.add(this.ballGroup);

    this.aimGroup = new THREE.Group();
    this.scene.add(this.aimGroup);

    this.trailGroup = new THREE.Group();
    this.scene.add(this.trailGroup);

    // Aim line: a solid, colored beam from the cue ball to the ghost ball / target ball.
    // A thin tube reads well up close; the 1 px line under it keeps the aim
    // visible from far away (WebGL ignores linewidth).
    const aimMat = new THREE.MeshBasicMaterial({
      color: AIM_COLOR, transparent: true, opacity: 0.92, depthWrite: false,
    });
    this.aimLine = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({
        color: AIM_COLOR, transparent: true, opacity: 0.95, depthWrite: false,
      }),
    );
    this.aimLine.frustumCulled = false;
    this.aimLine.renderOrder = 4;   // over the cue-ball path where they overlap
    this.aimGroup.add(this.aimLine);
    this.aimBeam = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 10, 1, true), aimMat);
    this.aimBeam.frustumCulled = false;
    this.aimBeam.renderOrder = 4;
    this.aimGroup.add(this.aimBeam);

    // Ghost ball: where the cue ball will sit at the moment of contact, with
    // its footprint on the cloth, plus a red dot on the exact contact point
    // and a yellow dot where the cue sightline points on the target ball.
    this.ghostBall = new THREE.Mesh(
      new THREE.SphereGeometry(this.ballR, 32, 20),
      new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.13, depthWrite: false,
      }),
    );
    this.ghostBall.renderOrder = 3;
    this.aimGroup.add(this.ghostBall);
    this.ghostRing = new THREE.Mesh(
      new THREE.RingGeometry(this.ballR * 0.9, this.ballR, 48),
      new THREE.MeshBasicMaterial({
        color: AIM_COLOR, transparent: true, opacity: 0.6, side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.ghostRing.rotation.x = -Math.PI / 2;
    this.aimGroup.add(this.ghostRing);

    this.contactDot = new THREE.Mesh(
      new THREE.SphereGeometry(0.0045, 16, 12),
      new THREE.MeshBasicMaterial({ color: CONTACT_COLOR }),
    );
    this.contactDot.renderOrder = 5;
    this.aimGroup.add(this.contactDot);

    this.aimDot = new THREE.Group();
    const aimDotOutline = new THREE.Mesh(
      new THREE.SphereGeometry(0.0044, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0x1a1408, side: THREE.BackSide }),
    );
    const aimDotCore = new THREE.Mesh(
      new THREE.SphereGeometry(0.0036, 16, 12),
      new THREE.MeshBasicMaterial({ color: AIM_DOT_COLOR }),
    );
    aimDotOutline.renderOrder = 6;
    aimDotCore.renderOrder = 6;
    this.aimDot.add(aimDotOutline, aimDotCore);
    this.aimGroup.add(this.aimDot);

    // Predicted trajectories (physics): first ball touched (T), cue ball (Y)
    this._paths = {};
    for (const [slot, color] of [['target', TARGET_COLOR], ['cue', CUE_PATH_COLOR]]) {
      const group = new THREE.Group();
      group.visible = false;
      this.scene.add(group);
      this._paths[slot] = { group, color, key: null };
    }

    this.stick = buildCueStick();
    this.aimGroup.add(this.stick);

    // soft ring marking the ball the camera follows
    this.focusRing = new THREE.Mesh(
      new THREE.RingGeometry(this.ballR * 1.06, this.ballR * 1.3, 36),
      new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.22, side: THREE.DoubleSide,
      }),
    );
    this.focusRing.rotation.x = -Math.PI / 2;
    this.focusRing.visible = false;
    this.scene.add(this.focusRing);
  }

  // ---------- camera ------------------------------------------------------

  setCamera(preset) {
    this.preset = preset;
    this._camGoal = null;
    const { w, l } = this._dims;
    if (preset === 'top') {
      this.camera.position.set(w / 2 + 0.0001, Y0 + 3.6, l / 2);
      this.controls.target.set(w / 2, Y0, l / 2);
    } else {  // 'tv': over the shoulder of whatever ball is followed
      const tg = this.controls.target;
      this.camera.position.set(tg.x + 0.02, tg.y + 1.55, tg.z - 1.05);
    }
    this.controls.update();
  }

  // Move the orbit pivot (and camera) to focus on a ball at table (x, y, z).
  // Does NOT run automatically during shots; only called when framing a ball.
  focusOn(x, y, z, { smooth = true, phi = null } = {}) {
    const ny = Y0 + Math.max(z ?? this.ballR, 0);
    if (this.preset === 'top') {
      this.setCamera('top');
      return;
    }
    const target = new THREE.Vector3(x, ny, y);
    let pos;
    if (typeof phi === 'number') {
      const rad = (phi * Math.PI) / 180;
      const curOffset = this.camera.position.clone().sub(this.controls.target);
      const curHoriz = Math.hypot(curOffset.x, curOffset.z) || 1.15;
      const curHeight = curOffset.y || 1.15;
      // Keep a comfortable over-the-cue framing so both the cue stick and aim line stay visible
      const horizDist = Math.max(0.95, Math.min(curHoriz, 1.35));
      const height = Math.max(0.75, Math.min(curHeight, 1.35));
      pos = new THREE.Vector3(
        x - Math.cos(rad) * horizDist,
        ny + height,
        y - Math.sin(rad) * horizDist,
      );
    } else {
      const offset = this.camera.position.clone().sub(this.controls.target);
      pos = target.clone().add(offset);
    }
    if (smooth) {
      this._camGoal = { target, pos };
    } else {
      this._camGoal = null;
      this.controls.target.copy(target);
      this.camera.position.copy(pos);
      this.controls.update();
    }
  }

  follow(x, y, z) {
    this.focusOn(x, y, z, { smooth: false });
  }

  // Free horizontal/vertical table exploration (WASD + Q/E), independent of any ball.
  panCamera(forward, right, up, dt) {
    if (!forward && !right && !up) return;
    this._camGoal = null;
    const viewDir = this.controls.target.clone().sub(this.camera.position);
    let fx = viewDir.x;
    let fz = viewDir.z;
    let fLen = Math.hypot(fx, fz);
    if (fLen < 1e-4) {
      // Top-down view: fall back to camera's screen-up projected onto XZ
      const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
      fx = camUp.x;
      fz = camUp.z;
      fLen = Math.hypot(fx, fz) || 1;
    }
    fx /= fLen;
    fz /= fLen;
    // Right vector in Three.js right-handed world (Y up): forward × up = (-fz, 0, fx)
    const rx = -fz;
    const rz = fx;

    const dx = (fx * forward + rx * right) * dt;
    const dz = (fz * forward + rz * right) * dt;
    const dy = up * dt;

    this.controls.target.x += dx;
    this.controls.target.z += dz;
    this.camera.position.x += dx;
    this.camera.position.z += dz;
    if (dy !== 0) {
      const nextCamY = Math.max(Y0 + 0.12, Math.min(4.5, this.camera.position.y + dy));
      this.camera.position.y = nextCamY;
    }
    this._clampTargetToRoom();
  }

  _clampTargetToRoom() {
    if (!this._dims) return;
    const pad = 0.85;
    const tg = this.controls.target;
    const clampedX = Math.max(-pad, Math.min(this._dims.w + pad, tg.x));
    const clampedZ = Math.max(-pad, Math.min(this._dims.l + pad, tg.z));
    const clampedY = Math.max(Y0 - 0.02, Math.min(Y0 + 0.6, tg.y));
    const dx = clampedX - tg.x;
    const dy = clampedY - tg.y;
    const dz = clampedZ - tg.z;
    if (dx !== 0 || dy !== 0 || dz !== 0) {
      tg.set(clampedX, clampedY, clampedZ);
      this.camera.position.x += dx;
      this.camera.position.y += dy;
      this.camera.position.z += dz;
    }
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
    this._syncPath(this._paths.target, scene.targetPath);
    this._syncPath(this._paths.cue, scene.cuePath);
    this._syncTrails(scene);
    if (this._camGoal) {
      this.controls.target.lerp(this._camGoal.target, 0.22);
      this.camera.position.lerp(this._camGoal.pos, 0.22);
      if (this.controls.target.distanceTo(this._camGoal.target) < 0.002 &&
          this.camera.position.distanceTo(this._camGoal.pos) < 0.002) {
        this.controls.target.copy(this._camGoal.target);
        this.camera.position.copy(this._camGoal.pos);
        this._camGoal = null;
      }
    }
    if (scene.focus && !scene.playing) {
      this.focusRing.position.set(scene.focus.xy[0], Y0 + 0.002, scene.focus.xy[1]);
      this.focusRing.visible = true;
    } else {
      this.focusRing.visible = false;
    }
    this.controls.update();
    if (!this._camGoal) this._clampTargetToRoom();
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
            map: this._ballTexture(b.id, b.id === 'cue'),
            roughness: 0.18, metalness: 0.05,
          }),
        );
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.baseQuat = new THREE.Quaternion();
        mesh.userData.shotQuat = new THREE.Quaternion();
        mesh.userData.hadShotQuat = false;
        mesh.userData.lastXY = [b.xy[0], b.xy[1]];
        this._ballMeshes.set(b.id, mesh);
        this.ballGroup.add(mesh);
      }
      const z = (b.z ?? this.ballR);
      mesh.position.set(b.xy[0], Y0 + Math.max(z, -0.1), b.xy[1]);
      mesh.scale.setScalar(b.scale ?? 1);
      mesh.material.opacity = b.alpha ?? 1;
      mesh.material.transparent = (b.alpha ?? 1) < 0.999;

      if (b.quat) {
        mesh.userData.shotQuat.set(b.quat[0], b.quat[1], b.quat[2], b.quat[3]);
        mesh.quaternion.multiplyQuaternions(mesh.userData.shotQuat, mesh.userData.baseQuat);
        mesh.userData.hadShotQuat = true;
        mesh.userData.lastXY = [b.xy[0], b.xy[1]];
      } else {
        if (mesh.userData.hadShotQuat) {
          mesh.userData.baseQuat.copy(mesh.quaternion);
          mesh.userData.hadShotQuat = false;
        }
        const prev = mesh.userData.lastXY;
        if (prev) {
          const dx = b.xy[0] - prev[0];
          const dy = b.xy[1] - prev[1];
          const dist = Math.hypot(dx, dy);
          if (dist > 1e-5 && dist < 0.5) {
            const rx = dy / this.ballR;
            const rz = -dx / this.ballR;
            const angle = Math.hypot(rx, rz);
            const axis = new THREE.Vector3(rx / angle, 0, rz / angle);
            const dq = new THREE.Quaternion().setFromAxisAngle(axis, angle);
            mesh.userData.baseQuat.premultiply(dq).normalize();
          }
        }
        mesh.userData.lastXY = [b.xy[0], b.xy[1]];
        mesh.quaternion.copy(mesh.userData.baseQuat);
      }
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
      // Pure, seamless amber-yellow phenolic cue ball (zero spots, dots, or seams)
      g.fillStyle = '#e8be3e';
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

    const { cue, dir: aimDir, lineStart, lineEnd, stick, ballR } = aim;
    const showLine = aim.showLine !== false && !!lineEnd;
    this.aimLine.visible = showLine;
    this.aimBeam.visible = showLine;
    if (showLine) {
      const zA = Y0 + ballR;
      const startX = lineStart ? lineStart[0] : (aimDir ? cue[0] + aimDir[0] * (ballR + 0.004) : cue[0]);
      const startY = lineStart ? lineStart[1] : (aimDir ? cue[1] + aimDir[1] * (ballR + 0.004) : cue[1]);
      const a = new THREE.Vector3(startX, zA, startY);
      const b = new THREE.Vector3(lineEnd[0], zA, lineEnd[1]);
      this.aimLine.geometry.setFromPoints([a, b]);
      this.aimLine.geometry.computeBoundingSphere();
      placeBeam(this.aimBeam, a, b, AIM_BEAM_R);
    }

    // ghost ball + red contact dot + yellow sightline aim dot
    const hasGhost = showLine && !!aim.ghost && !!aim.objBall;
    const showGhost = hasGhost && aim.showGhost !== false;
    const showContact = hasGhost && aim.showContactDot !== false;
    this.ghostBall.visible = showGhost;
    this.ghostRing.visible = showGhost;
    this.contactDot.visible = showContact;
    if (hasGhost) {
      const [gx, gy] = aim.ghost;
      if (showGhost) {
        this.ghostBall.position.set(gx, Y0 + ballR, gy);
        this.ghostRing.position.set(gx, Y0 + 0.0015, gy);
      }
      if (showContact) {
        const [bx, by] = aim.objBall.xy;
        const ox = bx - gx, oy = by - gy;
        const n = Math.hypot(ox, oy) || 1;
        this.contactDot.position.set(bx - (ox / n) * ballR, Y0 + ballR, by - (oy / n) * ballR);
      }
    }

    const hasAimDot = showLine && !!aim.aimDot && !!aim.aimBall;
    this.aimDot.visible = hasAimDot;
    if (hasAimDot) {
      const [bx, by] = aim.aimBall.xy;
      const dx = aim.aimDot[0] - bx;
      const dy = aim.aimDot[1] - by;
      const dn = Math.hypot(dx, dy);
      const nx = dn > 1e-6 ? dx / dn : -(aimDir?.[0] || 0);
      const ny = dn > 1e-6 ? dy / dn : -(aimDir?.[1] || 1);
      const rProud = ballR + 0.0009;
      this.aimDot.position.set(bx + nx * rProud, Y0 + ballR, by + ny * rProud);
    }

    // stick: mesh origin is its tip end, so anchor it at the TIP point and
    // aim its local +Y (tip direction) from butt toward tip
    const tipY = Y0 + (stick.tipZ ?? ballR);
    const buttY = Y0 + (stick.buttZ ?? ballR);
    const tip = new THREE.Vector3(stick.tip[0], tipY, stick.tip[1]);
    const butt = new THREE.Vector3(stick.butt[0], buttY, stick.butt[1]);

    const dir = tip.clone().sub(butt).normalize();   // butt -> tip (+Y local)
    this.stick.position.copy(tip);
    this.stick.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  }

  // Predicted ball path (rebuilt only when the prediction changes): a tube +
  // 1 px line, ending in a green ring if the ball drops, else a faint ghost
  // of the ball where it comes to rest.
  _syncPath(slot, tp) {
    if (!tp || !tp.pts || tp.pts.length < 2) {
      slot.group.visible = false;
      return;
    }
    slot.group.visible = true;
    if (tp.key === slot.key) return;
    slot.key = tp.key;
    for (const child of slot.group.children) {
      child.geometry?.dispose();
      child.material?.dispose();
    }
    slot.group.clear();

    // drop near-duplicate samples (resting / slow tail) to keep the tube light
    const verts = [];
    for (const p of tp.pts) {
      const v = new THREE.Vector3(p[0], Y0 + Math.max(p[2] ?? this.ballR, 0), p[1]);
      if (!verts.length || verts[verts.length - 1].distanceTo(v) > 0.004) verts.push(v);
    }
    const lastP = tp.pts[tp.pts.length - 1];
    const lastV = new THREE.Vector3(lastP[0], Y0 + this.ballR, lastP[1]);
    if (verts[verts.length - 1].distanceTo(lastV) > 1e-4) verts.push(lastV);
    if (verts.length < 2) return;

    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(verts),
      new THREE.LineBasicMaterial({
        color: slot.color, transparent: true, opacity: 0.95, depthWrite: false,
      }),
    );
    line.frustumCulled = false;
    line.renderOrder = 2;
    slot.group.add(line);

    const path = new THREE.CurvePath();
    for (let i = 1; i < verts.length; i++) path.add(new THREE.LineCurve3(verts[i - 1], verts[i]));
    const tube = new THREE.Mesh(
      new THREE.TubeGeometry(path, Math.min(600, verts.length * 2), AIM_BEAM_R, 6, false),
      new THREE.MeshBasicMaterial({
        color: slot.color, transparent: true, opacity: 0.85, depthWrite: false,
      }),
    );
    tube.frustumCulled = false;
    tube.renderOrder = 2;
    slot.group.add(tube);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(this.ballR * 0.85, this.ballR, 48),
      new THREE.MeshBasicMaterial({
        color: tp.potted ? POT_COLOR : slot.color, transparent: true, opacity: 0.75,
        side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(lastP[0], Y0 + 0.0016, lastP[1]);
    slot.group.add(ring);
    if (!tp.potted) {
      const ghost = new THREE.Mesh(
        new THREE.SphereGeometry(this.ballR, 28, 16),
        new THREE.MeshBasicMaterial({
          color: slot.color, transparent: true, opacity: 0.12, depthWrite: false,
        }),
      );
      ghost.position.set(lastP[0], Y0 + this.ballR, lastP[1]);
      ghost.renderOrder = 3;
      slot.group.add(ghost);
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

  // Aiming target pick: raycasts 3D object-ball spheres first so clicking on a
  // target ball from any camera angle aims directly at that surface point
  // without plane-projection parallax, then falls back to the ball-center plane.
  aimFromClient(px, py, excludeBallId = null) {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 2) return null;
    this._ndc.set((px / rect.width) * 2 - 1, -(py / rect.height) * 2 + 1);
    this._raycaster.setFromCamera(this._ndc, this.camera);
    const targets = [];
    for (const [id, mesh] of this._ballMeshes) {
      if (id !== excludeBallId && mesh.visible) targets.push(mesh);
    }
    if (targets.length) {
      const hits = this._raycaster.intersectObjects(targets, false);
      if (hits.length) {
        return [hits[0].point.x, hits[0].point.z];
      }
    }
    const hit = this._raycaster.ray.intersectPlane(this._pickPlane, this._pickOut);
    return hit ? [this._pickOut.x, this._pickOut.z] : null;
  }
}

// ---------- Russian Pyramid table & pocket geometry builders ----------------

// Stretch a unit open cylinder (height 1 along +Y) between world points a, b.
function placeBeam(mesh, a, b, radius) {
  const dir = b.clone().sub(a);
  const len = dir.length();
  if (len < 1e-6) { mesh.visible = false; return; }
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.divideScalar(len));
  mesh.scale.set(radius, len, radius);
}

// Extrude a 2D shape defined in table (x, y) coordinates so its top face sits
// at world y = topY and extrudes downward by `height`.
function extrudeTableShape(shape, topY, height, material, extra = {}) {
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: false,
    curveSegments: 24,
    ...extra,
  });
  geo.rotateX(Math.PI / 2);
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.y = topY;
  return mesh;
}

function roundedRectShape(x, y, w, h, r) {
  const s = new THREE.Shape();
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
  s.lineTo(x + w, y + h - r);
  s.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false);
  s.lineTo(x + r, y + h);
  s.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(x, y + r);
  s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
  s.closePath();
  return s;
}

function polyToShape(pts) {
  const s = new THREE.Shape();
  s.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
  s.closePath();
  return s;
}

// Build a THREE.Shape from polygon vertices `pts` with circular-arc fillet
// radius `radii[i]` at each vertex `i` (used for the rounded pocket jaw horns).
function roundedPolyToShape(pts, radii, arcSteps = 16) {
  const n = pts.length;
  const s = new THREE.Shape();
  let started = false;
  const moveOrLine = (x, y) => {
    if (!started) { s.moveTo(x, y); started = true; }
    else s.lineTo(x, y);
  };
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const curr = pts[i];
    const next = pts[(i + 1) % n];
    const r = radii?.[i] ?? 0;
    const dx1 = prev[0] - curr[0], dy1 = prev[1] - curr[1];
    const dx2 = next[0] - curr[0], dy2 = next[1] - curr[1];
    const len1 = Math.hypot(dx1, dy1), len2 = Math.hypot(dx2, dy2);
    if (r <= 1e-5 || len1 < 1e-5 || len2 < 1e-5) {
      moveOrLine(curr[0], curr[1]);
      continue;
    }
    const u1x = dx1 / len1, u1y = dy1 / len1;
    const u2x = dx2 / len2, u2y = dy2 / len2;
    const cosA = Math.max(-0.999, Math.min(0.999, u1x * u2x + u1y * u2y));
    const halfAngle = 0.5 * Math.acos(cosA);
    const tanHalf = Math.tan(halfAngle);
    const sinHalf = Math.sin(halfAngle);
    if (tanHalf < 1e-4 || sinHalf < 1e-4) {
      moveOrLine(curr[0], curr[1]);
      continue;
    }
    const maxDist = 0.45 * Math.min(len1, len2);
    const d = Math.min(r / tanHalf, maxDist);
    const rEff = d * tanHalf;
    const t1x = curr[0] + u1x * d, t1y = curr[1] + u1y * d;
    const t2x = curr[0] + u2x * d, t2y = curr[1] + u2y * d;
    const bx = u1x + u2x, by = u1y + u2y;
    const bLen = Math.hypot(bx, by) || 1;
    const cDist = rEff / sinHalf;
    const cx = curr[0] + (bx / bLen) * cDist;
    const cy = curr[1] + (by / bLen) * cDist;
    const a1 = Math.atan2(t1y - cy, t1x - cx);
    const a2 = Math.atan2(t2y - cy, t2x - cx);
    const da = Math.atan2(Math.sin(a2 - a1), Math.cos(a2 - a1));
    moveOrLine(t1x, t1y);
    for (let k = 1; k <= arcSteps; k++) {
      const a = a1 + (da * k) / arcSteps;
      s.lineTo(cx + Math.cos(a) * rEff, cy + Math.sin(a) * rEff);
    }
  }
  s.closePath();
  return s;
}

// Six cushion polygons in table (x, y) with per-vertex rounding radii:
// 5 mm rounded corner jaw noses (72.5 mm throat) and 11 mm rounded side jaw
// noses (82.0 mm mouth).
function buildCushionPolygons(w, l, cw, cNose, cBack, sNose, sBack) {
  const my = l / 2;
  const rC = 0.005;   // R1 = 5 mm corner nose (regulation, = physics corner_jaw_radius)
  const rS = 0.011;   // R2 = 11 mm side nose (regulation, = physics side_jaw_radius)
  const rB = 0.004;
  return [
    // left-bottom long cushion
    { pts: [[-cw, cBack], [0, cNose], [0, my - sNose], [-cw, my - sBack]], radii: [rB, rC, rS, rB] },
    // left-top long cushion
    { pts: [[-cw, my + sBack], [0, my + sNose], [0, l - cNose], [-cw, l - cBack]], radii: [rB, rS, rC, rB] },
    // right-bottom long cushion
    { pts: [[w + cw, cBack], [w, cNose], [w, my - sNose], [w + cw, my - sBack]], radii: [rB, rC, rS, rB] },
    // right-top long cushion
    { pts: [[w + cw, my + sBack], [w, my + sNose], [w, l - cNose], [w + cw, l - cBack]], radii: [rB, rS, rC, rB] },
    // bottom (head) short cushion
    { pts: [[cBack, -cw], [cNose, 0], [w - cNose, 0], [w - cBack, -cw]], radii: [rB, rC, rC, rB] },
    // top (foot) short cushion
    { pts: [[cBack, l + cw], [cNose, l], [w - cNose, l], [w - cBack, l + cw]], radii: [rB, rC, rC, rB] },
  ];
}

// Six wooden rail sections (поручни) behind the cushions, stopping at each
// pocket bracket.
function buildWoodenRailPolygons(w, l, cw, wood, cNose, sNose) {
  const my = l / 2;
  const rOut = cw + wood;
  const cIn = 0.036;                    // where wood rail meets corner bracket at cw
  const cOut = cIn - wood * 0.55;       // angled end across the wood rail
  const sEnd = sNose + 0.016;           // where wood rail meets side bracket
  return [
    // left-bottom rail
    [[-rOut, cOut], [-cw, cIn], [-cw, my - sEnd], [-rOut, my - sEnd]],
    // left-top rail
    [[-rOut, my + sEnd], [-cw, my + sEnd], [-cw, l - cIn], [-rOut, l - cOut]],
    // right-bottom rail
    [[w + rOut, cOut], [w + cw, cIn], [w + cw, my - sEnd], [w + rOut, my - sEnd]],
    // right-top rail
    [[w + rOut, my + sEnd], [w + cw, my + sEnd], [w + cw, l - cIn], [w + rOut, l - cOut]],
    // bottom short rail
    [[cOut, -rOut], [cIn, -cw], [w - cIn, -cw], [w - cOut, -rOut]],
    // top short rail
    [[cOut, l + rOut], [cIn, l + cw], [w - cIn, l + cw], [w - cOut, l + rOut]],
  ];
}

function pocketPt(ps, s, t) {
  return [
    ps.origin[0] + ps.u[0] * s + ps.v[0] * t,
    ps.origin[1] + ps.u[1] * s + ps.v[1] * t,
  ];
}

// 2D Path of the pocket opening (straight jaw throat + circular well + concave
// cloth fall-edge between the jaw horns).
function pocketCutoutPath(ps, pad = 0, target = new THREE.Path()) {
  const hm = ps.halfMouth + pad;
  const hb = ps.halfBack + pad;
  const rw = ps.rWell + pad;
  const sIn = ps.sIn - pad * 0.5;
  const sOut = ps.sOut;
  const sWell = ps.sWell;

  const pStart = pocketPt(ps, sIn, -hm);
  target.moveTo(pStart[0], pStart[1]);

  // -t straight jaw wall from horn to back of cushion
  const pJawNeg = pocketPt(ps, sOut, -hb);
  target.lineTo(pJawNeg[0], pJawNeg[1]);

  // circular pocket basket behind the jaws
  const a0 = -Math.asin(Math.min(0.99, hb / rw));
  const a1 = -a0;
  const steps = 22;
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    const s = sWell + Math.cos(a) * rw;
    const t = Math.sin(a) * rw;
    const p = pocketPt(ps, s, t);
    target.lineTo(p[0], p[1]);
  }

  // +t straight jaw wall back to +t horn
  const pJawPos = pocketPt(ps, sOut, hb);
  target.lineTo(pJawPos[0], pJawPos[1]);
  const pEnd = pocketPt(ps, sIn, hm);
  target.lineTo(pEnd[0], pEnd[1]);

  // concave slate/cloth fall-edge (скат лузы) across the mouth
  const pCtrl = pocketPt(ps, ps.sLip - pad * 0.5, 0);
  target.quadraticCurveTo(pCtrl[0], pCtrl[1], pStart[0], pStart[1]);
  target.closePath();
  return target;
}

function pocketLipShape(ps) {
  const outer = pocketCutoutPath(ps, 0.0025, new THREE.Shape());
  outer.holes.push(pocketCutoutPath(ps, -0.001, new THREE.Path()));
  return outer;
}

// Build a complete Russian Pyramid pocket: recessed dark drop well, net basket
// straps/rings, leather jaw facings (губы), curved leather apron/hood
// (пелерина), and polished brass bracket (скоба).
function buildRussianPocket(group, ps, railTop, mats) {
  const wellDepth = POCKET_WELL_DEPTH;

  // 1. Deep dark pocket well wall + bottom disc
  const wellOuter = pocketCutoutPath(ps, 0.004, new THREE.Shape());
  wellOuter.holes.push(pocketCutoutPath(ps, -0.0005, new THREE.Path()));
  const wellWall = extrudeTableShape(wellOuter, Y0 - 0.0008, wellDepth, mats.holeMat);
  group.add(wellWall);

  const bottomShape = pocketCutoutPath(ps, 0.003, new THREE.Shape());
  const bottom = extrudeTableShape(bottomShape, Y0 - wellDepth, 0.004, mats.holeMat);
  group.add(bottom);

  // 2. Leather-and-cord net basket rings inside the well
  for (const h of [0.028, 0.056, 0.084]) {
    const ringShape = pocketArcBandShape(ps, ps.rWell - 0.002, ps.rWell + 0.003, -Math.PI * 0.62, Math.PI * 0.62);
    const ring = extrudeTableShape(ringShape, Y0 - h, 0.005, mats.netMat);
    group.add(ring);
  }

  // 3. Curved leather pocket apron / guard (кожаная пелерина) wrapping the back
  // of the pocket from one cushion/rail end to the other
  const maxAng = ps.corner ? Math.PI * 0.66 : Math.PI * 0.58;
  const apronBody = pocketArcBandShape(ps, ps.rWell - 0.001, ps.rWell + 0.022, -maxAng, maxAng);
  const apronMesh = extrudeTableShape(
    apronBody,
    railTop + 0.0015,
    CUSHION_H + (Y0 - WOOD_TOP) + 0.010,
    mats.leatherMat,
    { bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.0015, bevelOffset: -0.0015, bevelSegments: 2 },
  );
  apronMesh.castShadow = true;
  apronMesh.receiveShadow = true;
  group.add(apronMesh);

  // Raised leather hood rim (высокая пелерина) around the back arc to catch hard shots
  const hoodAng = ps.corner ? Math.PI * 0.56 : Math.PI * 0.50;
  const hoodShape = pocketArcBandShape(ps, ps.rWell + 0.002, ps.rWell + 0.015, -hoodAng, hoodAng);
  const hoodMesh = extrudeTableShape(
    hoodShape,
    railTop + 0.0085,
    0.009,
    mats.leatherRimMat,
    { bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.0015, bevelOffset: -0.001, bevelSegments: 2 },
  );
  hoodMesh.castShadow = true;
  group.add(hoodMesh);

  // 5. Polished brass pocket bracket (латунная скоба) hugging the outer rim of
  // the leather apron and anchoring into the adjacent wooden rails
  const bracketAng = ps.corner ? Math.PI * 0.72 : Math.PI * 0.66;
  const bracketShape = pocketArcBandShape(ps, ps.rWell + 0.019, ps.rWell + 0.033, -bracketAng, bracketAng);
  const bracketMesh = extrudeTableShape(
    bracketShape,
    railTop + 0.001,
    0.018,
    mats.brassMat,
    { bevelEnabled: true, bevelThickness: 0.0012, bevelSize: 0.001, bevelOffset: -0.0008, bevelSegments: 2 },
  );
  bracketMesh.castShadow = true;
  group.add(bracketMesh);
}

// Horseshoe / arc-band shape in table (x, y) around a pocket's circular well.
function pocketArcBandShape(ps, rInner, rOuter, aStart, aEnd, steps = 26) {
  const s = new THREE.Shape();
  for (let i = 0; i <= steps; i++) {
    const a = aStart + ((aEnd - aStart) * i) / steps;
    const p = pocketPt(ps, ps.sWell + Math.cos(a) * rOuter, Math.sin(a) * rOuter);
    if (i === 0) s.moveTo(p[0], p[1]);
    else s.lineTo(p[0], p[1]);
  }
  for (let i = steps; i >= 0; i--) {
    const a = aStart + ((aEnd - aStart) * i) / steps;
    const p = pocketPt(ps, ps.sWell + Math.cos(a) * rInner, Math.sin(a) * rInner);
    s.lineTo(p[0], p[1]);
  }
  s.closePath();
  return s;
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

  for (const m of [shaft, tip, wrap]) m.frustumCulled = false;
  group.add(shaft, tip, wrap);
  return group;
}
