const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.dirname(require.resolve('../package.json'));

/** Loads theme/responsive.ts against a fake device window. */
function loadResponsive({ width, height, isPad = false, os = 'ios' }) {
  const window = { width, height };
  const reactNative = {
    Dimensions: { get: () => window },
    PixelRatio: { roundToNearestPixel: (v) => v },
    Platform: { OS: os, isPad },
    useWindowDimensions: () => window,
  };
  const file = path.join(root, 'theme/responsive.ts');
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  const localRequire = (id) => {
    if (id === 'react-native') return reactNative;
    if (id === 'react') return { useMemo: (fn) => fn() };
    throw new Error(`Unexpected dependency: ${id}`);
  };
  new Function('require', 'module', 'exports', source)(localRequire, module, module.exports);
  return module.exports;
}

const IPHONE_17_PRO = { width: 402, height: 874 };
const IPHONE_SE = { width: 375, height: 667 };
const ANDROID_PHONE = { width: 360, height: 800, os: 'android' };
const IPAD_11 = { width: 834, height: 1194, isPad: true };
const IPAD_13 = { width: 1032, height: 1376, isPad: true };

test('the content column never narrows a phone screen', () => {
  for (const phone of [IPHONE_17_PRO, IPHONE_SE, ANDROID_PHONE, { width: 440, height: 956 }]) {
    const r = loadResponsive(phone);
    assert.ok(r.CONTENT_MAX_WIDTH > phone.width, `${phone.width}pt phone was capped at ${r.CONTENT_MAX_WIDTH}`);
    assert.equal(r.isTablet, false);
  }
});

test('iPads get a centered column narrower than the screen', () => {
  for (const ipad of [IPAD_11, IPAD_13]) {
    const r = loadResponsive(ipad);
    assert.equal(r.isTablet, true);
    assert.ok(r.CONTENT_MAX_WIDTH < ipad.width);
    assert.equal(r.contentColumn.alignSelf, 'center');
    assert.equal(r.contentColumn.maxWidth, r.CONTENT_MAX_WIDTH);
  }
});

test('sizes do not depend on orientation', () => {
  const portrait = loadResponsive(IPAD_11);
  const landscape = loadResponsive({ ...IPAD_11, width: IPAD_11.height, height: IPAD_11.width });
  for (const fn of ['s', 'vs', 'ms', 'fs']) assert.equal(portrait[fn](20), landscape[fn](20), fn);
  assert.equal(portrait.CONTENT_MAX_WIDTH, landscape.CONTENT_MAX_WIDTH);
});

test('phone sizes match the previous width/height scaling', () => {
  const r = loadResponsive(IPHONE_17_PRO);
  assert.equal(r.s(100), Math.round((100 * 402) / 390));
  assert.equal(r.vs(100), Math.round((100 * 874) / 844));
});

test('fitCoverBox keeps the phone video box and stops crops on wide windows', () => {
  const { fitCoverBox } = loadResponsive(IPHONE_17_PRO);
  const ar = 9 / 16;
  // iPhone 17 Pro: unchanged from the old width*0.8 × min(width/ar, height*0.55) box.
  assert.deepEqual(fitCoverBox(402 * 0.8, 874 * 0.55, ar), { width: 322, height: 481 });
  // iPad landscape: was 955×459 (a face strip); now a portrait box with at most 20% crop.
  const box = fitCoverBox(Math.min(1194 * 0.8, 718), 834 * 0.55, ar);
  assert.equal(box.height, 459);
  assert.ok(box.width / box.height <= ar * 1.2 + 0.01);
  // Never wider than allowed.
  assert.ok(fitCoverBox(200, 1000, ar).width <= 200);
});
