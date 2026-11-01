import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PERFORMANCE_PRESET,
  PERFORMANCE_PRESETS,
  PERFORMANCE_PRESET_IDS,
  PERFORMANCE_PRESET_STORAGE_KEY,
  _resetPerformancePresetForTest,
  adoptInitialPerformancePreset,
  applyPerformanceSettingsToScene,
  applyPerformanceSettingsToTileset,
  choosePerformancePreset,
  describeWebglRenderer,
  getPerformancePreset,
  getPerformancePresetSource,
  getPerformanceSettings,
  installPerformancePreset,
  isSoftwareRenderer,
  normalizePerformancePreset,
  performanceCadenceScale,
  performancePresetFromSearch,
  performanceScaledBudget,
  persistPerformancePreset,
  presetPixelRatio,
  readStoredPerformancePreset,
  refreshImageryOnAnisotropyChange,
  resolvePixelRatio,
  setPerformancePreset,
  subscribeDrawingBuffer,
  subscribePerformancePreset,
} from './performancePreset.js';

const { quality, balanced, performance } = PERFORMANCE_PRESETS;
const MiB = 1024 * 1024;
const SOFTWARE =
  'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)';
const RTX =
  'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 (0x00002484) Direct3D11 vs_5_0 ps_5_0, D3D11)';

function storage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    map,
  };
}

function fakeTileset() {
  return {
    maximumScreenSpaceError: 16,
    dynamicScreenSpaceError: true,
    dynamicScreenSpaceErrorFactor: 24,
    skipLevelOfDetail: false,
    cacheBytes: 1536 * MiB,
    maximumCacheOverflowBytes: 1024 * MiB,
    isDestroyed: () => false,
  };
}

/**
 * A viewer whose CesiumWidget-like resize sizes the canvas the way Cesium
 * does: client size x (device pixel ratio unless the browser's recommended
 * resolution is used) x resolutionScale.
 */
function fakeViewer({ clientWidth = 1600, clientHeight = 900, dpr = 1 } = {}) {
  const canvas = {
    clientWidth,
    clientHeight,
    width: clientWidth,
    height: clientHeight,
  };
  const resizes = [];
  const viewer = {
    canvas,
    useBrowserRecommendedResolution: true,
    resolutionScale: 1,
    targetFrameRate: 60,
    scene: {
      msaaSamples: 4,
      postProcessStages: { fxaa: { enabled: false } },
      globe: { maximumScreenSpaceError: 2, tileCacheSize: 100 },
    },
    dpr,
    resizes,
  };
  viewer.cesiumWidget = {
    resize() {
      const ratio =
        (viewer.useBrowserRecommendedResolution ? 1 : viewer.dpr) *
        viewer.resolutionScale;
      canvas.width = Math.floor(canvas.clientWidth * ratio);
      canvas.height = Math.floor(canvas.clientHeight * ratio);
      resizes.push({ width: canvas.width, height: canvas.height });
    },
  };
  return viewer;
}

function install(viewer, options = {}) {
  return installPerformancePreset(viewer, {
    renderer: RTX,
    getDevicePixelRatio: () => viewer.dpr,
    ...options,
  });
}

test.beforeEach(() => _resetPerformancePresetForTest());

test('Balanced is the default and every preset id has a frozen settings table', () => {
  assert.equal(DEFAULT_PERFORMANCE_PRESET, 'balanced');
  assert.equal(getPerformancePreset(), 'balanced');
  assert.equal(getPerformancePresetSource(), null);
  assert.deepEqual(Object.keys(PERFORMANCE_PRESETS), [
    ...PERFORMANCE_PRESET_IDS,
  ]);
  for (const id of PERFORMANCE_PRESET_IDS) {
    const preset = PERFORMANCE_PRESETS[id];
    assert.equal(preset.id, id);
    assert.ok(Object.isFrozen(preset) && Object.isFrozen(preset.pixelRatio));
  }
});

test('presets step down in cost and sharpness from Quality to Performance', () => {
  for (const dpr of [1, 1.25, 1.5, 2, 3]) {
    assert.ok(
      presetPixelRatio(quality, dpr) >= presetPixelRatio(balanced, dpr),
    );
    assert.ok(
      presetPixelRatio(balanced, dpr) > presetPixelRatio(performance, dpr),
    );
  }
  assert.ok(quality.msaaSamples > balanced.msaaSamples);
  assert.ok(balanced.msaaSamples > performance.msaaSamples);
  assert.ok(quality.targetFrameRate >= balanced.targetFrameRate);
  assert.ok(balanced.targetFrameRate > performance.targetFrameRate);
  assert.ok(quality.detectionDensityPct >= balanced.detectionDensityPct);
  assert.ok(balanced.detectionDensityPct > performance.detectionDensityPct);
  assert.ok(quality.cadenceScale <= balanced.cadenceScale);
  assert.ok(balanced.cadenceScale < performance.cadenceScale);
  assert.ok(quality.trafficDotScale >= balanced.trafficDotScale);
  assert.ok(balanced.trafficDotScale > performance.trafficDotScale);
  // Finer imagery and 3D tiles, a deeper tile cache and sharper filtering.
  assert.deepEqual(
    PERFORMANCE_PRESET_IDS.map(
      (id) => PERFORMANCE_PRESETS[id].globeMaximumScreenSpaceError,
    ),
    [1, 1.5, 2],
  );
  assert.deepEqual(
    PERFORMANCE_PRESET_IDS.map(
      (id) => PERFORMANCE_PRESETS[id].globeTileCacheSize,
    ),
    [600, 300, 100],
  );
  assert.deepEqual(
    PERFORMANCE_PRESET_IDS.map(
      (id) => PERFORMANCE_PRESETS[id].imageryMaximumAnisotropy,
    ),
    [16, 8, 4],
  );
  assert.deepEqual(
    PERFORMANCE_PRESET_IDS.map(
      (id) => PERFORMANCE_PRESETS[id].tileMaximumScreenSpaceError,
    ),
    [12, 16, 24],
  );
  assert.ok(quality.tileCacheBytes > balanced.tileCacheBytes);
  assert.ok(balanced.tileCacheBytes > performance.tileCacheBytes);
  // Balanced keeps Cesium's Google tileset defaults; only Performance skips
  // levels of detail; every preset relaxes the horizon dynamically.
  assert.equal(balanced.tileMaximumScreenSpaceError, 16);
  assert.equal(balanced.tileCacheBytes, 1536 * MiB);
  assert.equal(balanced.tileCacheOverflowBytes, 1024 * MiB);
  assert.deepEqual(
    PERFORMANCE_PRESET_IDS.map(
      (id) => PERFORMANCE_PRESETS[id].tileSkipLevelOfDetail,
    ),
    [false, false, true],
  );
  for (const id of PERFORMANCE_PRESET_IDS)
    assert.equal(PERFORMANCE_PRESETS[id].tileDynamicScreenSpaceError, true);
  // Performance is Cesium's globe defaults: no extra load on a weak GPU.
  assert.equal(performance.globeMaximumScreenSpaceError, 2);
  assert.equal(performance.globeTileCacheSize, 100);
});

test('one anti-aliasing pass per preset, and no sharpen over an upscaled buffer', () => {
  for (const id of PERFORMANCE_PRESET_IDS) {
    const preset = PERFORMANCE_PRESETS[id];
    assert.notEqual(
      preset.msaaSamples > 1,
      preset.fxaa,
      `${id} runs exactly one AA pass`,
    );
    if (presetPixelRatio(preset, 1) < 1)
      assert.equal(preset.sharpenPermitted, false, `${id} upscales`);
  }
  assert.equal(quality.sharpenPermitted, true);
  assert.equal(balanced.sharpenPermitted, true);
  assert.equal(performance.sharpenPermitted, false);
  // PR #4's anti-aliasing choices stand.
  assert.deepEqual(
    PERFORMANCE_PRESET_IDS.map((id) => [
      PERFORMANCE_PRESETS[id].msaaSamples,
      PERFORMANCE_PRESETS[id].fxaa,
    ]),
    [
      [4, false],
      [2, false],
      [1, true],
    ],
  );
});

test('pixel ratios: Quality every device pixel, Balanced three quarters never below CSS, Performance half with a 0.75 floor', () => {
  assert.equal(presetPixelRatio(quality, 1), 1);
  assert.equal(presetPixelRatio(quality, 1.5), 1.5);
  assert.equal(presetPixelRatio(quality, 2), 2);
  assert.equal(presetPixelRatio(quality, 3), 2, 'capped at two per CSS pixel');
  assert.equal(presetPixelRatio(balanced, 1), 1, 'never below CSS resolution');
  assert.equal(presetPixelRatio(balanced, 1.25), 1);
  assert.equal(presetPixelRatio(balanced, 2), 1.5);
  assert.equal(presetPixelRatio(balanced, 3), 1.5);
  assert.equal(presetPixelRatio(performance, 1), 0.75);
  assert.equal(presetPixelRatio(performance, 1.5), 0.75);
  assert.equal(presetPixelRatio(performance, 2), 1);
  assert.equal(presetPixelRatio(performance, 3), 1);
  assert.equal(presetPixelRatio(quality, 0), 1, 'a missing ratio reads as 1');
  assert.equal(presetPixelRatio(quality, Number.NaN), 1);
});

test('a 1600 x 900 window at DPR 1 draws 1600 x 900 in Balanced and Quality, 1200 x 675 in Performance', () => {
  const viewport = {
    devicePixelRatio: 1,
    clientWidth: 1600,
    clientHeight: 900,
  };
  for (const [preset, buffer, scale] of [
    [quality, { width: 1600, height: 900 }, 1],
    [balanced, { width: 1600, height: 900 }, 1],
    [performance, { width: 1200, height: 675 }, 0.75],
  ]) {
    const resolved = resolvePixelRatio(preset, viewport);
    assert.deepEqual(resolved.drawingBuffer, buffer, preset.id);
    assert.equal(resolved.resolutionScale, scale, preset.id);
    assert.equal(resolved.clampedBy, null);
  }
});

test('resolvePixelRatio clamps to the GPU texture limit and reports the scale Cesium needs', () => {
  assert.deepEqual(
    resolvePixelRatio(quality, {
      devicePixelRatio: 2,
      clientWidth: 1600,
      clientHeight: 900,
      maxTextureSize: 16384,
    }),
    {
      pixelRatio: 2,
      wanted: 2,
      resolutionScale: 1,
      clampedBy: null,
      drawingBuffer: { width: 3200, height: 1800 },
    },
  );
  const clamped = resolvePixelRatio(quality, {
    devicePixelRatio: 2,
    clientWidth: 3000,
    clientHeight: 1600,
    maxTextureSize: 4096,
  });
  assert.equal(clamped.clampedBy, 'texture-size');
  assert.equal(clamped.wanted, 2);
  assert.ok(Math.abs(clamped.pixelRatio - 4096 / 3000) < 1e-12);
  assert.equal(clamped.drawingBuffer.width, 4096);
  assert.ok(clamped.drawingBuffer.height <= 4096);
  assert.ok(Math.abs(clamped.resolutionScale - 4096 / 3000 / 2) < 1e-12);
  // Balanced at DPR 2 is 1.5 device pixels per CSS pixel: resolutionScale 0.75.
  const mid = resolvePixelRatio(balanced, {
    devicePixelRatio: 2,
    clientWidth: 1600,
    clientHeight: 900,
  });
  assert.equal(mid.pixelRatio, 1.5);
  assert.equal(mid.resolutionScale, 0.75);
  assert.deepEqual(mid.drawingBuffer, { width: 2400, height: 1350 });
  // Performance at DPR 2 draws CSS resolution: resolutionScale 0.5.
  assert.equal(
    resolvePixelRatio(performance, { devicePixelRatio: 2 }).resolutionScale,
    0.5,
  );
  // A hidden canvas (no size) and a missing limit never clamp.
  const hidden = resolvePixelRatio(quality, {
    devicePixelRatio: 2,
    maxTextureSize: 0,
  });
  assert.equal(hidden.pixelRatio, 2);
  assert.equal(hidden.clampedBy, null);
});

test('normalize accepts any case and whitespace and falls back for the rest', () => {
  assert.equal(normalizePerformancePreset(' Quality '), 'quality');
  assert.equal(normalizePerformancePreset('PERFORMANCE'), 'performance');
  assert.equal(normalizePerformancePreset('ultra'), 'balanced');
  assert.equal(normalizePerformancePreset(undefined, null), null);
  assert.equal(normalizePerformancePreset(42, 'quality'), 'quality');
});

test('setting a preset notifies listeners once per real change, with the previous settings', () => {
  const seen = [];
  const stop = subscribePerformancePreset((id, settings, previous) =>
    seen.push([id, settings.id, previous.id]),
  );
  assert.equal(setPerformancePreset('performance'), true);
  assert.equal(setPerformancePreset('performance'), false);
  assert.equal(setPerformancePreset('nonsense'), false);
  assert.equal(getPerformancePreset(), 'performance');
  assert.equal(getPerformancePresetSource(), 'user');
  assert.equal(getPerformanceSettings(), PERFORMANCE_PRESETS.performance);
  stop();
  assert.equal(setPerformancePreset('quality'), true);
  assert.deepEqual(seen, [['performance', 'performance', 'balanced']]);
});

test('a listener that throws does not stop the others or the switch', () => {
  const seen = [];
  subscribePerformancePreset(() => {
    throw new Error('boom');
  });
  subscribePerformancePreset((id) => seen.push(id));
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(setPerformancePreset('quality'), true);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(seen, ['quality']);
  assert.equal(getPerformancePreset(), 'quality');
});

test('cadence scale and budgets follow the active preset and are read live', () => {
  assert.equal(performanceCadenceScale(), 1);
  assert.equal(performanceScaledBudget(6000), 6000);
  setPerformancePreset('performance');
  assert.equal(performanceCadenceScale(), performance.cadenceScale);
  assert.equal(
    performanceScaledBudget(6000),
    Math.round(6000 * performance.trafficDotScale),
  );
  assert.equal(performanceScaledBudget(1), 1);
  assert.equal(performanceScaledBudget(Number.NaN), Number.NaN);
});

test('stored preference round-trips and tolerates missing or broken storage', () => {
  const store = storage();
  assert.equal(readStoredPerformancePreset(store), null);
  assert.equal(persistPerformancePreset('Performance', store), true);
  assert.equal(store.map.get(PERFORMANCE_PRESET_STORAGE_KEY), 'performance');
  assert.equal(readStoredPerformancePreset(store), 'performance');
  assert.equal(persistPerformancePreset('bogus', store), false);
  assert.equal(
    readStoredPerformancePreset(
      storage({ [PERFORMANCE_PRESET_STORAGE_KEY]: 'bogus' }),
    ),
    null,
  );
  assert.equal(readStoredPerformancePreset(null), null);
  assert.equal(readStoredPerformancePreset(undefined), null);
  const broken = {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('denied');
    },
  };
  assert.equal(readStoredPerformancePreset(broken), null);
  assert.equal(persistPerformancePreset('quality', broken), false);
});

test('?quality= names a preset for one load and ignores anything else', () => {
  assert.equal(performancePresetFromSearch('?quality=Quality&x=1'), 'quality');
  assert.equal(
    performancePresetFromSearch('?welcome=0&quality=performance'),
    'performance',
  );
  assert.equal(performancePresetFromSearch('?quality=ultra'), null);
  assert.equal(performancePresetFromSearch(''), null);
  assert.equal(performancePresetFromSearch(undefined), null);
});

test('software rasterizers are recognised from the unmasked WebGL renderer', () => {
  assert.equal(isSoftwareRenderer(SOFTWARE), true);
  assert.equal(isSoftwareRenderer('llvmpipe (LLVM 15.0.7, 256 bits)'), true);
  assert.equal(isSoftwareRenderer('Microsoft Basic Render Driver'), true);
  assert.equal(isSoftwareRenderer(RTX), false);
  assert.equal(isSoftwareRenderer(null), false);
  const gl = {
    getExtension: (name) =>
      name === 'WEBGL_debug_renderer_info'
        ? { UNMASKED_RENDERER_WEBGL: 37446 }
        : null,
    getParameter: (id) => (id === 37446 ? RTX : 'WebKit WebGL'),
  };
  assert.equal(describeWebglRenderer({ getContext: () => gl }), RTX);
  assert.equal(
    describeWebglRenderer({
      getContext: (type) => (type === 'webgl' ? gl : null),
    }),
    RTX,
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

test('the page load starts on ?quality=, then the remembered choice, then the hardware default', () => {
  assert.deepEqual(choosePerformancePreset(), {
    id: 'balanced',
    source: 'default',
  });
  assert.deepEqual(choosePerformancePreset({ softwareRenderer: true }), {
    id: 'performance',
    source: 'default',
  });
  assert.deepEqual(
    choosePerformancePreset({ stored: 'quality', softwareRenderer: true }),
    { id: 'quality', source: 'stored' },
  );
  assert.deepEqual(
    choosePerformancePreset({ query: 'performance', stored: 'quality' }),
    { id: 'performance', source: 'query' },
  );
  assert.deepEqual(choosePerformancePreset({ query: 'ultra', stored: 'x' }), {
    id: 'balanced',
    source: 'default',
  });
});

test('the initial choice is settled once, so a ?quality= override survives the remembered value', () => {
  const store = storage({ [PERFORMANCE_PRESET_STORAGE_KEY]: 'balanced' });
  assert.deepEqual(
    adoptInitialPerformancePreset({
      search: '?quality=quality',
      storage: store,
    }),
    { id: 'quality', source: 'query' },
  );
  // The Display row asks again later with the same storage: no change.
  assert.deepEqual(adoptInitialPerformancePreset({ storage: store }), {
    id: 'quality',
    source: 'query',
  });
  // A one-load override is never written back.
  assert.equal(store.map.get(PERFORMANCE_PRESET_STORAGE_KEY), 'balanced');
});

test('a default settled before the renderer was known drops to Performance on a software rasterizer, a remembered choice does not', () => {
  assert.deepEqual(adoptInitialPerformancePreset({ storage: storage() }), {
    id: 'balanced',
    source: 'default',
  });
  const seen = [];
  subscribePerformancePreset((id) => seen.push(id));
  assert.deepEqual(adoptInitialPerformancePreset({ renderer: SOFTWARE }), {
    id: 'performance',
    source: 'default',
  });
  assert.deepEqual(seen, ['performance']);
  _resetPerformancePresetForTest();
  adoptInitialPerformancePreset({
    storage: storage({ [PERFORMANCE_PRESET_STORAGE_KEY]: 'quality' }),
  });
  assert.deepEqual(adoptInitialPerformancePreset({ renderer: SOFTWARE }), {
    id: 'quality',
    source: 'stored',
  });
  _resetPerformancePresetForTest();
  adoptInitialPerformancePreset({ renderer: RTX });
  assert.equal(getPerformancePreset(), 'balanced');
});

test('scene application writes every knob once and reports what changed', () => {
  const viewer = fakeViewer();
  const tileset = fakeTileset();
  const viewport = {
    devicePixelRatio: 1,
    clientWidth: 1600,
    clientHeight: 900,
  };
  const changed = applyPerformanceSettingsToScene(viewer, performance, {
    tileset,
    viewport,
  });
  assert.deepEqual(changed, [
    'useBrowserRecommendedResolution',
    'resolutionScale',
    'targetFrameRate',
    'msaaSamples',
    'fxaa',
    'maximumScreenSpaceError',
    'dynamicScreenSpaceErrorFactor',
    'skipLevelOfDetail',
    'cacheBytes',
    'maximumCacheOverflowBytes',
  ]);
  assert.equal(viewer.useBrowserRecommendedResolution, false);
  assert.equal(viewer.resolutionScale, 0.75);
  assert.equal(viewer.targetFrameRate, 30);
  assert.equal(viewer.scene.msaaSamples, 1);
  assert.equal(viewer.scene.postProcessStages.fxaa.enabled, true);
  // Performance is the globe's Cesium defaults, so nothing changed there.
  assert.deepEqual(viewer.scene.globe, {
    maximumScreenSpaceError: 2,
    tileCacheSize: 100,
  });
  assert.equal(tileset.maximumScreenSpaceError, 24);
  assert.equal(tileset.dynamicScreenSpaceErrorFactor, 32);
  assert.equal(tileset.skipLevelOfDetail, true);
  assert.equal(tileset.cacheBytes, 768 * MiB);
  assert.equal(tileset.maximumCacheOverflowBytes, 512 * MiB);
  // Re-applying the same preset is a no-op.
  assert.deepEqual(
    applyPerformanceSettingsToScene(viewer, performance, { tileset, viewport }),
    [],
  );
  // Quality: every device pixel, 4x MSAA, finest globe and tiles.
  applyPerformanceSettingsToScene(viewer, quality, {
    tileset,
    viewport: { ...viewport, devicePixelRatio: 2 },
  });
  assert.equal(viewer.resolutionScale, 1);
  assert.equal(viewer.scene.msaaSamples, 4);
  assert.equal(viewer.scene.postProcessStages.fxaa.enabled, false);
  assert.deepEqual(viewer.scene.globe, {
    maximumScreenSpaceError: 1,
    tileCacheSize: 600,
  });
  assert.equal(tileset.maximumScreenSpaceError, 12);
  assert.equal(tileset.dynamicScreenSpaceErrorFactor, 12);
  assert.equal(tileset.skipLevelOfDetail, false);
  assert.equal(tileset.cacheBytes, 2048 * MiB);
});

test('scene application tolerates a partial viewer, no tileset and a destroyed tileset', () => {
  assert.deepEqual(applyPerformanceSettingsToScene(null, quality), []);
  const bare = { scene: {} };
  assert.deepEqual(applyPerformanceSettingsToScene(bare, performance), [
    'useBrowserRecommendedResolution',
    'resolutionScale',
    'targetFrameRate',
    'msaaSamples',
  ]);
  const destroyed = { maximumScreenSpaceError: 16, isDestroyed: () => true };
  applyPerformanceSettingsToScene(bare, quality, { tileset: destroyed });
  assert.equal(destroyed.maximumScreenSpaceError, 16);
  assert.deepEqual(applyPerformanceSettingsToTileset(null, quality), []);
});

test('install settles the page load, keeps the scene in step, and uninstalls', () => {
  const viewer = fakeViewer();
  const tileset = fakeTileset();
  const store = storage({ [PERFORMANCE_PRESET_STORAGE_KEY]: 'performance' });
  const renders = [];
  const preset = install(viewer, {
    tileset,
    storage: store,
    requestRender: (reason) => renders.push(reason),
  });
  assert.equal(getPerformancePreset(), 'performance');
  assert.equal(getPerformancePresetSource(), 'stored');
  assert.equal(viewer.useBrowserRecommendedResolution, false);
  assert.equal(viewer.resolutionScale, 0.75);
  assert.equal(viewer.targetFrameRate, 30);
  assert.equal(viewer.scene.msaaSamples, 1);
  assert.equal(tileset.maximumScreenSpaceError, 24);
  assert.deepEqual(renders, []);
  setPerformancePreset('quality');
  assert.equal(viewer.resolutionScale, 1);
  assert.equal(viewer.targetFrameRate, 60);
  assert.equal(viewer.scene.msaaSamples, 4);
  assert.equal(viewer.scene.globe.maximumScreenSpaceError, 1);
  assert.equal(tileset.maximumScreenSpaceError, 12);
  assert.deepEqual(renders, ['performance-preset']);
  preset.uninstall();
  preset.uninstall();
  setPerformancePreset('performance');
  assert.equal(viewer.targetFrameRate, 60);
});

test('install without a stored value keeps Balanced, and a software rasterizer starts on Performance', () => {
  const viewer = fakeViewer();
  install(viewer, { storage: storage() });
  assert.equal(getPerformancePreset(), 'balanced');
  assert.equal(viewer.scene.msaaSamples, balanced.msaaSamples);
  assert.equal(viewer.resolutionScale, 1);
  _resetPerformancePresetForTest();
  const soft = fakeViewer();
  install(soft, { storage: storage(), renderer: SOFTWARE });
  assert.equal(getPerformancePreset(), 'performance');
  assert.equal(soft.scene.msaaSamples, 1);
  _resetPerformancePresetForTest();
  install(fakeViewer(), { search: '?quality=quality', renderer: SOFTWARE });
  assert.equal(getPerformancePreset(), 'quality');
});

test('install probes the canvas for the renderer when none is given', () => {
  const viewer = fakeViewer();
  viewer.canvas.getContext = () => ({
    getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 1 }),
    getParameter: () => SOFTWARE,
  });
  const preset = installPerformancePreset(viewer, {
    getDevicePixelRatio: () => 1,
  });
  assert.equal(getPerformancePreset(), 'performance');
  assert.equal(preset.describe().softwareRenderer, true);
});

test('every Cesium resize re-applies the ratio: a HiDPI screen, a texture limit, and back', () => {
  const viewer = fakeViewer({ dpr: 2 });
  let limit = 16384;
  const buffers = [];
  subscribeDrawingBuffer((buffer) => buffers.push(buffer));
  const preset = install(viewer, {
    search: '?quality=quality',
    getMaxTextureSize: () => limit,
  });
  viewer.cesiumWidget.resize();
  assert.deepEqual(viewer.resizes.at(-1), { width: 3200, height: 1800 });
  assert.deepEqual(buffers, [{ width: 3200, height: 1800 }]);
  // A steady frame changes nothing and reports nothing.
  viewer.cesiumWidget.resize();
  assert.equal(buffers.length, 1);
  // The window grows past the limit: 2 x 2560 would exceed 4096.
  limit = 4096;
  viewer.canvas.clientWidth = 2560;
  viewer.canvas.clientHeight = 1440;
  viewer.cesiumWidget.resize();
  assert.ok(Math.abs(viewer.resolutionScale - 4096 / 2560 / 2) < 1e-12);
  assert.equal(viewer.canvas.width, 4096);
  assert.equal(preset.describe().clampedBy, 'texture-size');
  // Balanced on the same screen: 1.5 per CSS pixel, still under the limit.
  setPerformancePreset('balanced');
  viewer.cesiumWidget.resize();
  assert.deepEqual(viewer.resizes.at(-1), { width: 3840, height: 2160 });
  // Moving to a DPR 1 screen: CSS resolution.
  viewer.dpr = 1;
  viewer.cesiumWidget.resize();
  assert.deepEqual(viewer.resizes.at(-1), { width: 2560, height: 1440 });
  assert.equal(viewer.resolutionScale, 1);
  assert.deepEqual(buffers.at(-1), { width: 2560, height: 1440 });
  const resize = viewer.cesiumWidget.resize;
  preset.uninstall();
  assert.notEqual(
    viewer.cesiumWidget.resize,
    resize,
    'uninstall unwraps resize',
  );
});

test('a tileset attached after install takes the active preset and follows changes', () => {
  const viewer = fakeViewer();
  const renders = [];
  const preset = install(viewer, {
    search: '?quality=quality',
    requestRender: (reason) => renders.push(reason),
  });
  const tileset = fakeTileset();
  const detach = preset.attachTileset(tileset);
  assert.equal(tileset.maximumScreenSpaceError, 12);
  assert.equal(tileset.cacheBytes, 2048 * MiB);
  assert.deepEqual(renders, ['performance-preset']);
  setPerformancePreset('performance');
  assert.equal(tileset.skipLevelOfDetail, true);
  assert.equal(tileset.maximumScreenSpaceError, 24);
  detach();
  setPerformancePreset('balanced');
  assert.equal(
    tileset.maximumScreenSpaceError,
    24,
    'a detached tileset is left alone',
  );
  const snapshot = preset.describe();
  assert.equal(snapshot.preset, 'balanced');
  assert.deepEqual(snapshot.drawingBuffer, { width: 1600, height: 900 });
  assert.equal(snapshot.msaaSamples, 2);
  assert.equal(snapshot.imageryMaximumAnisotropy, 8);
  assert.equal(snapshot.tileset, null);
});

test('the base map imagery is rebuilt only when a change alters the anisotropy cap', () => {
  const refreshes = [];
  const stop = refreshImageryOnAnisotropyChange(() => refreshes.push(true));
  setPerformancePreset('quality');
  setPerformancePreset('quality');
  setPerformancePreset('performance');
  assert.equal(refreshes.length, 2);
  stop();
  setPerformancePreset('balanced');
  assert.equal(refreshes.length, 2);
  assert.equal(typeof refreshImageryOnAnisotropyChange(null), 'function');
});
