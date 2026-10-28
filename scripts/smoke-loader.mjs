// Module-resolution hook for ui_smoke.mjs: mirrors the browser import map
// ({"three": vendor/three.module.js, "three/addons/": vendor/}) so the real
// frontend modules can be imported under Node.

const VENDOR = new URL('../src/russian_pyramid/static/vendor/', import.meta.url);
const THREE_URL = new URL('three.module.js', VENDOR).href;
const CONTROLS_PREFIX = 'three/addons/controls/';

export async function resolve(specifier, context, next) {
  if (specifier === 'three') {
    return { url: THREE_URL, shortCircuit: true };
  }
  if (specifier.startsWith(CONTROLS_PREFIX)) {
    return {
      url: new URL(specifier.slice(CONTROLS_PREFIX.length), VENDOR).href,
      shortCircuit: true,
    };
  }
  return next(specifier, context);
}
