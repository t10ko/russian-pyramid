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
  else if (fixtures[path]) payload = fixtures[path];
  else throw new Error(`unexpected fetch: ${path} ${JSON.stringify(body).slice(0, 80)}`);
  return { ok: true, status: 200, json: async () => payload };
};

// ---------------------------------------------------------------- drive it
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

// aim interaction: rotate + power nudges, then render
app.nudgeAim(0.25);
app.nudgePower(0.5);
pumpFrames(3);

// aim assist on -> predict fetch -> render with paths
app.setAssist(true);
await sleep(400);
pumpFrames(3);

// shoot with the captured payload, run playback to completion at 2x
await app.shoot();
app.playback.speed = 2;
let frames = 0;
while ((app.playback.playing || app.playback.time < app.playback.duration) && frames < 2000) {
  pumpFrames(1);
  frames++;
}
pumpFrames(5);

// repeat the situation (undo), re-render
await app.repeatSituation();
pumpFrames(3);

// replay the attempt from history
app.replayLast();
pumpFrames(10);

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
