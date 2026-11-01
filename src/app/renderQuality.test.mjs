import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RENDER_QUALITY_DEFAULT,
  RENDER_QUALITY_NAMES,
  RENDER_QUALITY_PRESETS,
  RENDER_QUALITY_STORAGE_KEY,
  applyRenderQualityToTileset,
  chooseRenderQuality,
  createRenderQualityController,
  describeWebglRenderer,
  isSoftwareRenderer,
  normalizeRenderQuality,
  presetPixelRatio,
  readStoredRenderQuality,
  renderQualityFromSearch,
  renderQualityPreset,
  resolvePixelRatio,
  writeStoredRenderQuality,
} from './renderQuality.js';

const { quality, balanced, performance } = RENDER_QUALITY_PRESETS;

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    map,
  };
}

function fakeViewer({ clientWidth = 1600, clientHeight = 900 } = {}) {
  const resizes = [];
  const canvas = { clientWidth, clientHeight, width: clientWidth, height: clientHeight };
  const viewer = {
    canvas,
    useBrowserRecommendedResolution: true,
    resolutionScale: 1,
    scene: {
      msaaSamples: 4,
      postProcessStages: { fxaa: { enabled: false } },
      globe: { maximumScreenSpaceError: 2, tileCacheSize: 100 },
      requestRender: () => {},
    },
    cesiumWidget: {
      resize() {
        resizes.push(viewer.resolutionScale);
      },
    },
    resizes,
  };
  return viewer;
}

test('the preset table is frozen, ordered by fidelity and complete', () => {
  assert.deepEqual(RENDER_QUALITY_NAMES, ['quality', 'balanced', 'performance']);
  assert.equal(RENDER_QUALITY_DEFAULT, 'quality');
  for (const name of RENDER_QUALITY_NAMES) {
    const preset = RENDER_QUALITY_PRESETS[name];
    assert.equal(preset.name, name);
    assert.ok(Object.isFrozen(preset) && Object.isFrozen(preset.tileset));
    for (const key of ['globe', 'imagery', 'tileset', 'pixelRatio'])
      assert.equal(typeof preset[key], 'object', `${name}.${key}`);
  }
  // Sharper presets ask for finer imagery and 3D tiles, and keep more tiles.
  assert.ok(
    quality.globe.maximumScreenSpaceError <
      balanced.globe.maximumScreenSpaceError &&
      balanced.globe.maximumScreenSpaceError <=
        performance.globe.maximumScreenSpaceError,
  );
  assert.ok(
    quality.tileset.maximumScreenSpaceError <
      balanced.tileset.maximumScreenSpaceError &&
      balanced.tileset.maximumScreenSpaceError <
        performance.tileset.maximumScreenSpaceError,
  );
  assert.ok(
    quality.globe.tileCacheSize > balanced.globe.tileCacheSize &&
      balanced.globe.tileCacheSize > performance.globe.tileCacheSize,
  );
  assert.ok(quality.tileset.cacheBytes > performance.tileset.cacheBytes);
  // Performance is Cesium's globe defaults: no regression for weak GPUs.
  assert.equal(performance.globe.maximumScreenSpaceError, 2);
  assert.equal(performance.globe.tileCacheSize, 100);
  // The photoreal tileset never preloads while another stack hides it.
  for (const name of RENDER_QUALITY_NAMES)
    assert.equal(RENDER_QUALITY_PRESETS[name].tileset.preloadWhenHidden, false);
});

test('MSAA, FXAA and sharpen stay coherent: one anti-aliasing pass, no sharpen over an upscale', () => {
  for (const name of RENDER_QUALITY_NAMES) {
    const preset = RENDER_QUALITY_PRESETS[name];
    const msaa = preset.msaaSamples > 1;
    assert.notEqual(msaa, preset.fxaa, `${name} runs exactly one AA pass`);
    const upscaled = presetPixelRatio(preset, 1) < 1;
    if (upscaled) assert.equal(preset.sharpenPermitted, false, name);
  }
  assert.equal(quality.sharpenPermitted, true);
  assert.equal(performance.sharpenPermitted, false);
});

test('normalizeRenderQuality accepts case and whitespace and refuses the rest', () => {
  assert.equal(normalizeRenderQuality(' Balanced '), 'balanced');
  assert.equal(normalizeRenderQuality('QUALITY'), 'quality');
  for (const bad of ['high', '', null, undefined, 42, {}])
    assert.equal(normalizeRenderQuality(bad), null);
  assert.equal(renderQualityPreset('nope'), quality);
  assert.equal(renderQualityPreset('performance'), performance);
});

test('pixel ratios: Quality draws every device pixel, Balanced three quarters, Performance half', () => {
  assert.equal(presetPixelRatio(quality, 1), 1);
  assert.equal(presetPixelRatio(quality, 1.5), 1.5);
  assert.equal(presetPixelRatio(quality, 2), 2);
  assert.equal(presetPixelRatio(quality, 3), 2, 'capped at two per CSS pixel');
  assert.equal(presetPixelRatio(balanced, 1), 1, 'never below CSS resolution');
  assert.equal(presetPixelRatio(balanced, 1.25), 1);
  assert.equal(presetPixelRatio(balanced, 2), 1.5);
  assert.equal(presetPixelRatio(balanced, 3), 1.5);
  assert.equal(presetPixelRatio(performance, 1), 0.75);
  assert.equal(presetPixelRatio(performance, 2), 1);
  assert.equal(presetPixelRatio(performance, 3), 1);
  assert.equal(presetPixelRatio(quality, 0), 1, 'a missing ratio reads as 1');
  assert.equal(presetPixelRatio(quality, NaN), 1);
});

test('resolvePixelRatio clamps the buffer to the GPU texture limit and reports the scale Cesium needs', () => {
  const plain = resolvePixelRatio(quality, {
    devicePixelRatio: 2,
    clientWidth: 1600,
    clientHeight: 900,
    maxTextureSize: 16384,
  });
  assert.deepEqual(plain, {
    pixelRatio: 2,
    wanted: 2,
    resolutionScale: 1,
    clampedBy: null,
    drawingBuffer: { width: 3200, height: 1800 },
  });
  const clamped = resolvePixelRatio(quality, {
    devicePixelRatio: 2,
    clientWidth: 3000,
    clientHeight: 1600,
    maxTextureSize: 4096,
  });
  assert.equal(clamped.clampedBy, 'texture-size');
  assert.ok(Math.abs(clamped.pixelRatio - 4096 / 3000) < 1e-9);
  assert.equal(clamped.drawingBuffer.width, 4096);
  assert.ok(Math.abs(clamped.resolutionScale - 4096 / 3000 / 2) < 1e-9);
  // Balanced at DPR 2 is 1.5 device pixels per CSS pixel: resolutionScale 0.75.
  const mid = resolvePixelRatio(balanced, {
    devicePixelRatio: 2,
    clientWidth: 1600,
    clientHeight: 900,
  });
  assert.equal(mid.pixelRatio, 1.5);
  assert.equal(mid.resolutionScale, 0.75);
  assert.deepEqual(mid.drawingBuffer, { width: 2400, height: 1350 });
  // A hidden canvas (no size) and a missing limit never clamp.
  const hidden = resolvePixelRatio(quality, {
    devicePixelRatio: 2,
    clientWidth: 0,
    clientHeight: 0,
    maxTextureSize: 0,
  });
  assert.equal(hidden.pixelRatio, 2);
  assert.equal(hidden.clampedBy, null);
});

test('chooseRenderQuality: query, then memory, then the hardware heuristic', () => {
  assert.deepEqual(chooseRenderQuality(), { name: 'quality', source: 'default' });
  assert.deepEqual(chooseRenderQuality({ coarsePointer: true }), {
    name: 'balanced',
    source: 'default',
  });
  assert.deepEqual(
    chooseRenderQuality({ softwareRenderer: true, coarsePointer: true }),
    { name: 'performance', source: 'default' },
  );
  assert.deepEqual(
    chooseRenderQuality({ stored: 'balanced', softwareRenderer: true }),
    { name: 'balanced', source: 'stored' },
  );
  assert.deepEqual(chooseRenderQuality({ query: 'performance', stored: 'quality' }), {
    name: 'performance',
    source: 'query',
  });
  assert.deepEqual(chooseRenderQuality({ query: 'ultra', stored: 'bogus' }), {
    name: 'quality',
    source: 'default',
  });
});

test('search and storage readers tolerate junk and broken storage', () => {
  assert.equal(renderQualityFromSearch('?quality=Balanced&x=1'), 'balanced');
  assert.equal(renderQualityFromSearch('?renderQuality=performance'), 'performance');
  assert.equal(renderQualityFromSearch('?quality=ultra'), null);
  assert.equal(renderQualityFromSearch(''), null);
  assert.equal(renderQualityFromSearch(undefined), null);
  const storage = memoryStorage({ [RENDER_QUALITY_STORAGE_KEY]: 'performance' });
  assert.equal(readStoredRenderQuality(storage), 'performance');
  assert.equal(readStoredRenderQuality(null), null);
  const throwing = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  assert.equal(readStoredRenderQuality(throwing), null);
  assert.equal(writeStoredRenderQuality(throwing, 'quality'), false);
  assert.equal(writeStoredRenderQuality(storage, 'nope'), false);
  assert.equal(writeStoredRenderQuality(storage, 'quality'), true);
  assert.equal(storage.map.get(RENDER_QUALITY_STORAGE_KEY), 'quality');
});

test('software renderers are recognised from the unmasked WebGL string', () => {
  assert.equal(
    isSoftwareRenderer(
      'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
    ),
    true,
  );
  assert.equal(isSoftwareRenderer('llvmpipe (LLVM 15.0.7, 256 bits)'), true);
  assert.equal(
    isSoftwareRenderer(
      'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 (0x00002484) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    ),
    false,
  );
  assert.equal(isSoftwareRenderer(null), false);
  const gl = {
    getExtension: (name) =>
      name === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 37446 } : null,
    getParameter: (id) => (id === 37446 ? 'Apple M5' : 'WebKit WebGL'),
  };
  assert.equal(describeWebglRenderer({ getContext: () => gl }), 'Apple M5');
  assert.equal(
    describeWebglRenderer({ getContext: (type) => (type === 'webgl' ? gl : null) }),
    'Apple M5',
  );
  assert.equal(describeWebglRenderer({ getContext: () => null }), null);
  assert.equal(describeWebglRenderer(null), null);
  assert.equal(
    describeWebglRenderer({
      getContext: () => {
        throw new Error('lost');
      },
    }),
    null,
  );
});

test('applyRenderQualityToTileset writes every tileset knob and skips destroyed tilesets', () => {
  const tileset = {};
  assert.equal(applyRenderQualityToTileset(tileset, quality), true);
  assert.deepEqual(tileset, { ...quality.tileset });
  assert.equal(applyRenderQualityToTileset({ isDestroyed: () => true }, quality), false);
  assert.equal(applyRenderQualityToTileset(null, quality), false);
});

test('the controller applies its preset to the viewer before the first frame and on every change', () => {
  const storage = memoryStorage();
  const renders = [];
  const controller = createRenderQualityController({
    storage,
    getDevicePixelRatio: () => 2,
  });
  assert.equal(controller.name, 'quality');
  assert.equal(controller.getSource(), 'default');
  const viewer = fakeViewer();
  controller.attach(viewer, {
    requestRender: (reason) => renders.push(reason),
    getMaxTextureSize: () => 16384,
    renderer: 'ANGLE (NVIDIA GeForce RTX 3070)',
  });
  assert.equal(viewer.useBrowserRecommendedResolution, false);
  assert.equal(viewer.resolutionScale, 1, 'DPR 2 at full device pixels');
  assert.equal(viewer.scene.msaaSamples, 4);
  assert.equal(viewer.scene.postProcessStages.fxaa.enabled, false);
  assert.equal(viewer.scene.globe.maximumScreenSpaceError, 1);
  assert.equal(viewer.scene.globe.tileCacheSize, 600);
  assert.deepEqual(renders, ['render-quality']);

  const seen = [];
  const unsubscribe = controller.subscribe((state) => seen.push(state));
  const tileset = {};
  controller.attachTileset(tileset);
  assert.equal(tileset.maximumScreenSpaceError, 12);

  assert.deepEqual(controller.set('performance'), { ok: true, name: 'performance' });
  assert.equal(viewer.resolutionScale, 0.5, 'DPR 2 at one device pixel per CSS pixel');
  assert.equal(viewer.scene.msaaSamples, 1);
  assert.equal(viewer.scene.postProcessStages.fxaa.enabled, true);
  assert.equal(viewer.scene.globe.maximumScreenSpaceError, 2);
  assert.equal(viewer.scene.globe.tileCacheSize, 100);
  assert.equal(tileset.maximumScreenSpaceError, 24);
  assert.equal(tileset.skipLevelOfDetail, true);
  assert.equal(storage.map.get(RENDER_QUALITY_STORAGE_KEY), 'performance');
  assert.equal(controller.getSource(), 'stored');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].name, 'performance');
  assert.equal(seen[0].previous, quality);
  assert.equal(seen[0].preset, performance);

  const refused = controller.set('ultra');
  assert.equal(refused.ok, false);
  assert.equal(refused.name, 'performance');
  assert.match(refused.error, /Unknown render quality/);
  assert.equal(seen.length, 1);

  assert.deepEqual(controller.set('balanced', { persist: false }), {
    ok: true,
    name: 'balanced',
  });
  assert.equal(storage.map.get(RENDER_QUALITY_STORAGE_KEY), 'performance');
  assert.equal(viewer.resolutionScale, 0.75, 'DPR 2 at 1.5 device pixels per CSS pixel');
  unsubscribe();
  controller.set('quality');
  assert.equal(seen.length, 2);

  const snapshot = controller.describe();
  assert.equal(snapshot.name, 'quality');
  assert.equal(snapshot.pixelRatio, 2);
  assert.equal(snapshot.softwareRenderer, false);
  assert.deepEqual(snapshot.cssViewport, { width: 1600, height: 900 });
  assert.equal(snapshot.globe.maximumScreenSpaceError, 1);
  controller.destroy();
  assert.equal(controller.set('balanced').ok, false);
});

test('the controller keeps the drawing buffer under the texture limit when the window grows', () => {
  const controller = createRenderQualityController({
    getDevicePixelRatio: () => 2,
  });
  const viewer = fakeViewer({ clientWidth: 1600, clientHeight: 900 });
  const originalResize = viewer.cesiumWidget.resize;
  controller.attach(viewer, { getMaxTextureSize: () => 4096, renderer: 'GPU' });
  assert.equal(viewer.resolutionScale, 1);
  // The window grows to 2560 CSS pixels: 2 x 2560 would exceed 4096.
  viewer.canvas.clientWidth = 2560;
  viewer.canvas.clientHeight = 1440;
  viewer.cesiumWidget.resize();
  assert.equal(viewer.resizes.length, 1, "Cesium's resize still runs");
  assert.ok(Math.abs(viewer.resolutionScale - 4096 / 2560 / 2) < 1e-9);
  assert.equal(controller.describe().clampedBy, 'texture-size');
  // Shrinking restores the preset's full ratio.
  viewer.canvas.clientWidth = 1600;
  viewer.canvas.clientHeight = 900;
  viewer.cesiumWidget.resize();
  assert.equal(viewer.resolutionScale, 1);
  controller.destroy();
  assert.equal(viewer.cesiumWidget.resize, originalResize, 'destroy unwraps resize');
});

test('a heuristic default drops to Performance on a software rasterizer, a remembered choice does not', () => {
  const soft = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))';
  const heuristic = createRenderQualityController({});
  heuristic.attach(fakeViewer(), { renderer: soft });
  assert.equal(heuristic.name, 'performance');
  assert.equal(heuristic.describe().softwareRenderer, true);
  const remembered = createRenderQualityController({
    storage: memoryStorage({ [RENDER_QUALITY_STORAGE_KEY]: 'quality' }),
  });
  remembered.attach(fakeViewer(), { renderer: soft });
  assert.equal(remembered.name, 'quality');
  const queried = createRenderQualityController({ search: '?quality=balanced' });
  queried.attach(fakeViewer(), { renderer: soft });
  assert.equal(queried.name, 'balanced');
  assert.equal(queried.getSource(), 'query');
  const touch = createRenderQualityController({ coarsePointer: true });
  assert.equal(touch.name, 'balanced');
});

test('listeners that throw do not break a preset change', () => {
  const controller = createRenderQualityController({});
  controller.attach(fakeViewer(), { renderer: 'GPU' });
  const warn = console.warn;
  const warned = [];
  console.warn = (...args) => warned.push(args);
  try {
    controller.subscribe(() => {
      throw new Error('boom');
    });
    let later = 0;
    controller.subscribe(() => later++);
    assert.equal(controller.set('balanced').ok, true);
    assert.equal(later, 1);
    assert.equal(warned.length, 1);
  } finally {
    console.warn = warn;
  }
});
