// Headless smoke test for the canvas frontend.
//
// Boots main.js in Node with a spec-checking Canvas stub (every method's
// argument count is validated against the HTML canvas spec, unknown methods
// throw), a minimal DOM stub, and a controllable clock, then drives:
// boot -> resize -> render frames -> shoot -> full playback -> banner.
// API payloads come from the real server (see FIXTURES below).
//
//   # regenerate fixtures, then:
//   node scripts/ui_smoke.mjs
//
// Exits non-zero on any exception, spec violation, or unknown canvas method.

import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const STATIC = new URL('../src/russian_pyramid/static/', import.meta.url);
const FIXTURES = {
  '/api/state': '/tmp/rp_fixture_state.json',
  '/api/shoot': '/tmp/rp_fixture_shoot.json',
  '/api/predict': '/tmp/rp_fixture_predict.json',
};

// ---------------------------------------------------------------- fake clock
let now = 0;
const rafQueue = [];
globalThis.performance = { now: () => now };
globalThis.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };

function pumpFrames(n, msPerFrame = 1000 / 60) {
  for (let i = 0; i < n; i++) {
    now += msPerFrame;
    const q = rafQueue.splice(0);
    for (const cb of q) cb(now);
  }
}

// ---------------------------------------------------------------- canvas stub
const violations = [];
const calls = {};

// method name -> [minArgs, maxArgs] per the HTML canvas spec
const CANVAS_SPEC = {
  arc: [5, 6], arcTo: [5, 5], ellipse: [7, 8], moveTo: [2, 2], lineTo: [2, 2],
  rect: [4, 4], fillRect: [4, 4], strokeRect: [4, 5], clearRect: [4, 4],
  bezierCurveTo: [6, 6], quadraticCurveTo: [4, 4], setLineDash: [1, 1],
  createLinearGradient: [4, 4], createRadialGradient: [6, 6],
  setTransform: [6, 6], translate: [2, 2], scale: [2, 2], rotate: [1, 1],
  fillText: [3, 4], strokeText: [3, 4], drawImage: [3, 9],
  beginPath: [0, 0], closePath: [0, 0], fill: [0, 1], stroke: [0, 1],
  clip: [0, 1], save: [0, 0], restore: [0, 0],
};

function gradientStub(name) {
  return {
    addColorStop: (offset, color) => {
      if (typeof offset !== 'number' || typeof color !== 'string') {
        violations.push(`${name}.addColorStop bad args: ${offset}, ${color}`);
      }
    },
  };
}

function makeCtx(name = 'ctx') {
  const store = {};
  return new Proxy({}, {
    get(_t, prop) {
      if (prop in store) return store[prop];
      if (prop === 'canvas') return null;
      if (prop.startsWith('create') && prop.endsWith('Gradient')) {
        return (...args) => {
          calls[prop] = (calls[prop] || 0) + 1;
          const [lo, hi] = CANVAS_SPEC[prop] ?? [0, 99];
          if (args.length < lo || args.length > hi) {
            violations.push(`${name}.${prop} wants ${lo}-${hi} args, got ${args.length}`);
          }
          return gradientStub(`${name}.${prop}`);
        };
      }
      const spec = CANVAS_SPEC[prop];
      if (spec) {
        return (...args) => {
          calls[prop] = (calls[prop] || 0) + 1;
          const [lo, hi] = spec;
          if (args.length < lo || args.length > hi) {
            violations.push(
              `${name}.${prop} wants ${lo}-${hi} args, got ${args.length}: ${JSON.stringify(args)}`);
          }
          for (const a of args) {
            if (typeof a === 'number' && !Number.isFinite(a)) {
              violations.push(`${name}.${prop} non-finite arg: ${args}`);
            }
          }
        };
      }
      throw new TypeError(`unknown canvas method: ${name}.${String(prop)}`);
    },
    set(_t, prop, value) { store[prop] = value; return true; },
  });
}

// ---------------------------------------------------------------- DOM stub
function makeElement(id) {
  const listeners = {};
  const el = {
    id,
    children: [],
    style: {},
    dataset: {},
    value: '',
    max: '',
    checked: false,
    disabled: false,
    title: '',
    className: '',
    innerHTML: '',
    textContent: '',
    width: 300,
    height: 150,
    getContext: () => makeCtx(`#${id}`),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 760 }),
    addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); },
    removeEventListener: () => {},
    dispatchEvent: (ev) => {
      for (const fn of listeners[ev?.type] || []) fn(ev);
    },
    appendChild: (child) => { el.children.push(child); return child; },
    remove: () => {},
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    querySelectorAll: () => [],
    classList: {
      add: () => {}, remove: () => {},
      toggle: () => {}, contains: () => false,
    },
    close: () => {}, showModal: () => {},
    insertAdjacentHTML: () => {},
  };
  return el;
}

const elements = new Map();
const getEl = (id) => {
  if (!elements.has(id)) elements.set(id, makeElement(id));
  return elements.get(id);
};

globalThis.window = { devicePixelRatio: 2, addEventListener: () => {} };
globalThis.document = {
  getElementById: getEl,
  createElement: (tag) => makeElement(tag),
  querySelectorAll: () => [],
  body: makeElement('body'),
};
globalThis.ResizeObserver = class {
  observe() {} unobserve() {} disconnect() {}
};

// ---------------------------------------------------------------- fetch stub
const fixtures = {};
for (const [path, file] of Object.entries(FIXTURES)) {
  fixtures[path] = JSON.parse(readFileSync(file, 'utf8'));
}
globalThis.fetch = async (path, opts) => {
  const body = opts?.body ? JSON.parse(opts.body) : {};
  let payload;
  if (path === '/api/aim') payload = fixtures['/api/state'].aim;
  else if (path === '/api/undo') payload = fixtures['/api/state'];
  else if (path === '/api/cue-ball') payload = { ...fixtures['/api/state'], cue_ball_id: body.id };
  else if (fixtures[path]) payload = fixtures[path];
  else throw new Error(`unexpected fetch: ${path} ${JSON.stringify(body).slice(0, 80)}`);
  return { ok: true, status: 200, json: async () => payload };
};

// ---------------------------------------------------------------- drive it
// Force the 2D renderer: the harness has no WebGL.  Register the import-map
// equivalent so `import 'three'` resolves to the vendored copy.
globalThis.__RP_FORCE_2D__ = true;
register(new URL('./smoke-loader.mjs', import.meta.url));

const mainUrl = pathToFileURL(new URL('../src/russian_pyramid/static/js/main.js', import.meta.url).pathname)
  .href;
await import(mainUrl);

// wait for app.init() to settle
let app = null;
for (let i = 0; i < 100 && !app?.state; i++) {
  app = globalThis.__russianPyramidApp;
  await sleep(10);
}
if (!app?.state) throw new Error('app did not finish init');

// let debounced aim sync fire, then render a few idle frames
await sleep(400);
pumpFrames(5);

// initially no shots to replay -> playback controls are disabled
if (!getEl('pl-play').disabled || !getEl('pl-scrub').disabled) {
  violations.push('playback controls should be disabled when there are no attempts');
}

// aim interaction: rotate + power nudges, then render
app.nudgeAim(0.25);
app.nudgePower(0.5);
pumpFrames(3);

// verify Shift+pointerdown does NOT jump phi, and pointermove rotates relatively
const phiBeforeDown = app.aim.phi;
const wrapEl = getEl('table-wrap');
const canvasEl = getEl('table3d');
wrapEl.dispatchEvent({ type: 'pointerdown', button: 0, shiftKey: true, pointerId: 1, clientX: 250, clientY: 200, target: canvasEl });
if (Math.abs(app.aim.phi - phiBeforeDown) > 1e-6) {
  violations.push(`Shift+pointerdown jumped phi from ${phiBeforeDown} to ${app.aim.phi}`);
}
wrapEl.dispatchEvent({ type: 'pointermove', button: 0, shiftKey: true, pointerId: 1, clientX: 290, clientY: 200, target: canvasEl });
if (Math.abs(app.aim.phi - phiBeforeDown) < 0.05) {
  violations.push('Shift+pointermove did not adjust phi relatively');
}
wrapEl.dispatchEvent({ type: 'pointerup', button: 0, shiftKey: true, pointerId: 1, clientX: 290, clientY: 200, target: canvasEl });
app.setAim({ phi: phiBeforeDown }, false);

// spin clamp check: setting spin outside MAX_SPIN_R (0.50) clamps radius to <= 0.50
app.setAim({ a: 0, b: 0 }, false);
const centerAim = app.buildScene().aim;
app.setAim({ a: 0.4, b: 0.3 }, false);
const spinAim = app.buildScene().aim;
// verify dashed line (lineStart -> lineEnd) is collinear with cue stick (butt -> tip)
const cueVec = [
  spinAim.stick.tip[0] - spinAim.stick.butt[0],
  spinAim.stick.tip[1] - spinAim.stick.butt[1],
];
const cueLen = Math.hypot(cueVec[0], cueVec[1]) || 1;
for (const pt of [spinAim.lineOrigin, spinAim.lineStart, spinAim.lineEnd]) {
  const rel = [pt[0] - spinAim.stick.tip[0], pt[1] - spinAim.stick.tip[1]];
  const cross = Math.abs(rel[0] * cueVec[1] - rel[1] * cueVec[0]) / cueLen;
  if (cross > 1e-6) {
    violations.push(`dashed aiming line is not collinear with off-center cue stick (cross=${cross})`);
  }
}
const dTipX = spinAim.stick.tip[0] - centerAim.stick.tip[0];
const dTipY = spinAim.stick.tip[1] - centerAim.stick.tip[1];
const dButtX = spinAim.stick.butt[0] - centerAim.stick.butt[0];
const dButtY = spinAim.stick.butt[1] - centerAim.stick.butt[1];
if (Math.hypot(dTipX, dTipY) < 0.005 || Math.hypot(dTipX - dButtX, dTipY - dButtY) > 1e-6) {
  violations.push('cue stick did not shift in parallel horizontally when a != 0');
}
if (spinAim.stick.tipZ <= centerAim.stick.tipZ + 0.005 ||
    Math.abs((spinAim.stick.tipZ - centerAim.stick.tipZ) - (spinAim.stick.buttZ - centerAim.stick.buttZ)) > 1e-6) {
  violations.push('cue stick did not shift in parallel vertically when b != 0');
}

app.setAim({ a: 0.9, b: 0.9 }, false);
const spinR = Math.hypot(app.aim.a, app.aim.b);
if (spinR > 0.501) {
  violations.push(`spin was not clamped to MAX_SPIN_R: r=${spinR.toFixed(3)}`);
}
app.setAim({ a: 0, b: 0 }, false);
pumpFrames(3);

// shoot with the captured payload, verify potted target ball "1" is visible at start of playback
await app.shoot();
const sceneAtShotStart = app.buildScene();
if (!sceneAtShotStart.balls.some(b => b.id === '1')) {
  violations.push('potted target ball "1" disappeared at the start of shot playback');
}
if (!sceneAtShotStart.aim?.stick || sceneAtShotStart.aim.showLine !== false) {
  violations.push('cue stick missing (or dashed line not hidden) during shot playback');
}
const shootTipStart = sceneAtShotStart.aim.stick.tip.slice();
pumpFrames(8);
const shootTipAfter = app.buildScene().aim?.stick?.tip;
if (!shootTipAfter || Math.hypot(shootTipAfter[0] - shootTipStart[0], shootTipAfter[1] - shootTipStart[1]) < 0.02) {
  violations.push('cue stick did not animate forward when shooting');
}
app.playback.speed = 2;
let frames = 0;
while ((app.playback.playing || app.playback.time < app.playback.duration) && frames < 2000) {
  pumpFrames(1);
  frames++;
}
pumpFrames(5);

// repeat the situation (undo), re-render; playback controls remain active for the cached attempt
await app.repeatSituation();
pumpFrames(3);
if (getEl('pl-play').disabled || getEl('pl-scrub').disabled) {
  violations.push('playback controls became disabled after repeatSituation even though attempt exists');
}

// choosing any ball ("1") switches the cue stick and active cueBallId to that ball
app.setFocusBall('1');
const sceneOn1 = app.buildScene();
const ball1 = sceneOn1.balls.find((b) => b.id === '1');
if (app.cueBallId !== '1' || !ball1?.isCue || !sceneOn1.aim ||
    Math.hypot(sceneOn1.aim.cue[0] - ball1.xy[0], sceneOn1.aim.cue[1] - ball1.xy[1]) > 1e-6) {
  violations.push('selecting ball "1" did not move the cue stick to ball "1"');
}
app.setFocusBall('cue');
pumpFrames(2);

// replay the attempt from history -> enters persistent Playback mode with locked Shot controls
app.setAim({ phi: 123.45, V0: 4.5 });
app.replayLast();
if (app.mode !== 'playback' || !getEl('power').disabled || !app.spinPad.disabled) {
  violations.push('replayLast did not enter playback mode and lock shot controls');
}
const replayTipStart = app.buildScene().aim?.stick?.tip?.slice();
pumpFrames(10);

// verify ball rotation quaternions and visible moving cue stick during replay
const sceneMid = app.buildScene();
if (!sceneMid.aim?.stick || sceneMid.aim.showLine !== false) {
  violations.push('cue stick not shown during replay');
}
if (!replayTipStart ||
    Math.hypot(sceneMid.aim.stick.tip[0] - replayTipStart[0], sceneMid.aim.stick.tip[1] - replayTipStart[1]) < 0.02) {
  violations.push('cue stick did not animate forward during replay');
}
for (const b of sceneMid.balls) {
  if (!b.quat || Math.abs(b.quat[3] - 1) < 1e-4) {
    violations.push(`ball ${b.id} did not rotate during playback`);
  }
}

// finish replay -> stays in Playback mode until user exits to Aim mode
let replayFrames = 0;
while ((app.playback.playing || app.playback.time < app.playback.duration) && replayFrames < 2000) {
  pumpFrames(1);
  replayFrames++;
}
if (app.mode !== 'playback' || !getEl('power').disabled || !app.spinPad.disabled) {
  violations.push('Playback mode exited automatically at end of replay instead of staying in Playback mode');
}
app.setMode('aim');
if (app.mode !== 'aim' || getEl('power').disabled || app.spinPad.disabled ||
    Math.abs(app.aim.phi - 123.45) > 1e-3) {
  violations.push('Exiting Playback mode via Aim did not unlock controls and restore live aim');
}

// verify 3D table + Russian Pyramid pocket geometry builds cleanly
const { Renderer3D } = await import(
  pathToFileURL(new URL('../src/russian_pyramid/static/js/render3d.js', import.meta.url).pathname).href
);
const r3dTest = Object.create(Renderer3D.prototype);
r3dTest.cloth = 'green';
r3dTest.ballR = app.ballRadius;
r3dTest.scene = { add() {} };
r3dTest._table(app.table);
if (!r3dTest.tableGroup || r3dTest.tableGroup.children.length < 30) {
  violations.push('3D table pocket/cushion geometry missing meshes');
}

// ---------------------------------------------------------------- verdict
const required = ['arc', 'arcTo', 'fillRect', 'createRadialGradient', 'drawImage'];
for (const m of required) {
  if (!calls[m]) violations.push(`expected canvas method never called: ${m}`);
}
if (violations.length) {
  console.error(`UI SMOKE FAILED — ${violations.length} violation(s):`);
  for (const v of violations) console.error('  ' + v);
  process.exit(1);
}
console.log('UI smoke OK');
console.log(`  canvas calls: ${Object.entries(calls).map(([k, n]) => `${k}×${n}`).join(', ')}`);
console.log(`  playback: ${app.playback.time.toFixed(1)}s / ${app.playback.duration.toFixed(1)}s, ` +
            `banner shown: ${getEl('banner').className || '(none)'}`);
