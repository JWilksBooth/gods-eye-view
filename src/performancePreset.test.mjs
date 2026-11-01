import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PERFORMANCE_PRESET,
  PERFORMANCE_PRESETS,
  PERFORMANCE_PRESET_IDS,
  PERFORMANCE_PRESET_STORAGE_KEY,
  _resetPerformancePresetForTest,
  applyPerformanceSettingsToScene,
  getPerformancePreset,
  getPerformanceSettings,
  installPerformancePreset,
  normalizePerformancePreset,
  performanceCadenceScale,
  performanceScaledBudget,
  persistPerformancePreset,
  readStoredPerformancePreset,
  setPerformancePreset,
  subscribePerformancePreset,
} from './performancePreset.js';

function storage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    map,
  };
}

function fakeViewer({ withTileset = true } = {}) {
  const viewer = {
    resolutionScale: 1,
    targetFrameRate: 60,
    scene: { msaaSamples: 4, postProcessStages: { fxaa: { enabled: false } } },
  };
  const tileset = withTileset
    ? {
        maximumScreenSpaceError: 16,
        cacheBytes: 1536 * 1024 * 1024,
        maximumCacheOverflowBytes: 1024 * 1024 * 1024,
        isDestroyed: () => false,
      }
    : null;
  return { viewer, tileset };
}

test.beforeEach(() => _resetPerformancePresetForTest());

test('Balanced is the default and every preset id has a settings table', () => {
  assert.equal(DEFAULT_PERFORMANCE_PRESET, 'balanced');
  assert.equal(getPerformancePreset(), 'balanced');
  assert.deepEqual(Object.keys(PERFORMANCE_PRESETS), [
    ...PERFORMANCE_PRESET_IDS,
  ]);
  for (const id of PERFORMANCE_PRESET_IDS) {
    assert.equal(PERFORMANCE_PRESETS[id].id, id);
    assert.ok(Object.isFrozen(PERFORMANCE_PRESETS[id]));
  }
});

test('presets step down in cost from Quality to Performance', () => {
  const { quality, balanced, performance } = PERFORMANCE_PRESETS;
  assert.ok(quality.resolutionScale >= balanced.resolutionScale);
  assert.ok(balanced.resolutionScale > performance.resolutionScale);
  assert.ok(quality.msaaSamples >= balanced.msaaSamples);
  assert.ok(balanced.msaaSamples > performance.msaaSamples);
  assert.ok(quality.targetFrameRate >= balanced.targetFrameRate);
  assert.ok(balanced.targetFrameRate > performance.targetFrameRate);
  assert.ok(quality.detectionDensityPct >= balanced.detectionDensityPct);
  assert.ok(balanced.detectionDensityPct > performance.detectionDensityPct);
  assert.ok(quality.cadenceScale <= balanced.cadenceScale);
  assert.ok(balanced.cadenceScale < performance.cadenceScale);
  assert.ok(quality.trafficDotScale >= balanced.trafficDotScale);
  assert.ok(balanced.trafficDotScale > performance.trafficDotScale);
  assert.ok(
    quality.tileMaximumScreenSpaceError <= balanced.tileMaximumScreenSpaceError,
  );
  assert.ok(
    balanced.tileMaximumScreenSpaceError <
      performance.tileMaximumScreenSpaceError,
  );
  assert.ok(quality.tileCacheBytes >= balanced.tileCacheBytes);
  assert.ok(balanced.tileCacheBytes > performance.tileCacheBytes);
  // Only the lightest preset drops the app's own sharpen pass; the pass is
  // a first-load default the other two keep.
  assert.equal(quality.sharpen, true);
  assert.equal(balanced.sharpen, true);
  assert.equal(performance.sharpen, false);
  // Performance keeps anti-aliasing through the cheap post-process pass.
  assert.equal(performance.msaaSamples, 1);
  assert.equal(performance.fxaa, true);
  // Quality and Balanced keep the default look: full resolution, no change
  // to label density, cadence or the photoreal globe's refinement.
  assert.equal(quality.resolutionScale, 1);
  assert.equal(balanced.resolutionScale, 1);
  assert.equal(balanced.cadenceScale, 1);
  assert.equal(balanced.detectionDensityPct, quality.detectionDensityPct);
  assert.equal(balanced.tileMaximumScreenSpaceError, 16);
});

test('normalize accepts any case and whitespace and falls back for the rest', () => {
  assert.equal(normalizePerformancePreset(' Quality '), 'quality');
  assert.equal(normalizePerformancePreset('PERFORMANCE'), 'performance');
  assert.equal(normalizePerformancePreset('ultra'), 'balanced');
  assert.equal(normalizePerformancePreset(undefined, null), null);
  assert.equal(normalizePerformancePreset(42, 'quality'), 'quality');
});

test('setting a preset notifies listeners once per real change and never for an unknown id', () => {
  const seen = [];
  const stop = subscribePerformancePreset((id, settings) =>
    seen.push([id, settings.id]),
  );
  assert.equal(setPerformancePreset('performance'), true);
  assert.equal(setPerformancePreset('performance'), false);
  assert.equal(setPerformancePreset('nonsense'), false);
  assert.equal(getPerformancePreset(), 'performance');
  assert.equal(getPerformanceSettings(), PERFORMANCE_PRESETS.performance);
  stop();
  assert.equal(setPerformancePreset('quality'), true);
  assert.deepEqual(seen, [['performance', 'performance']]);
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
  assert.equal(
    performanceCadenceScale(),
    PERFORMANCE_PRESETS.performance.cadenceScale,
  );
  assert.equal(
    performanceScaledBudget(6000),
    Math.round(6000 * PERFORMANCE_PRESETS.performance.trafficDotScale),
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

test('scene application writes every knob once and reports what changed', () => {
  const { viewer, tileset } = fakeViewer();
  const changed = applyPerformanceSettingsToScene(
    viewer,
    PERFORMANCE_PRESETS.performance,
    { tileset },
  );
  assert.deepEqual(changed, [
    'resolutionScale',
    'targetFrameRate',
    'msaaSamples',
    'fxaa',
    'maximumScreenSpaceError',
    'cacheBytes',
    'maximumCacheOverflowBytes',
  ]);
  assert.equal(viewer.resolutionScale, 0.75);
  assert.equal(viewer.targetFrameRate, 30);
  assert.equal(viewer.scene.msaaSamples, 1);
  assert.equal(viewer.scene.postProcessStages.fxaa.enabled, true);
  assert.equal(tileset.maximumScreenSpaceError, 24);
  assert.equal(tileset.cacheBytes, 768 * 1024 * 1024);
  assert.equal(tileset.maximumCacheOverflowBytes, 512 * 1024 * 1024);
  // Re-applying the same preset is a no-op.
  assert.deepEqual(
    applyPerformanceSettingsToScene(viewer, PERFORMANCE_PRESETS.performance, {
      tileset,
    }),
    [],
  );
  // Quality restores the SDK defaults.
  applyPerformanceSettingsToScene(viewer, PERFORMANCE_PRESETS.quality, {
    tileset,
  });
  assert.equal(viewer.resolutionScale, 1);
  assert.equal(viewer.scene.msaaSamples, 4);
  assert.equal(viewer.scene.postProcessStages.fxaa.enabled, false);
  assert.equal(tileset.maximumScreenSpaceError, 16);
});

test('scene application tolerates a partial viewer, no tileset and a destroyed tileset', () => {
  assert.deepEqual(
    applyPerformanceSettingsToScene(null, PERFORMANCE_PRESETS.quality),
    [],
  );
  const bare = { scene: {} };
  const changed = applyPerformanceSettingsToScene(
    bare,
    PERFORMANCE_PRESETS.performance,
  );
  assert.deepEqual(changed, [
    'resolutionScale',
    'targetFrameRate',
    'msaaSamples',
  ]);
  const destroyed = { maximumScreenSpaceError: 16, isDestroyed: () => true };
  applyPerformanceSettingsToScene(bare, PERFORMANCE_PRESETS.quality, {
    tileset: destroyed,
  });
  assert.equal(destroyed.maximumScreenSpaceError, 16);
});

test('install adopts the remembered preset, keeps the scene in step, and uninstalls', () => {
  const { viewer, tileset } = fakeViewer();
  const store = storage({ [PERFORMANCE_PRESET_STORAGE_KEY]: 'performance' });
  const renders = [];
  const uninstall = installPerformancePreset(viewer, {
    tileset,
    storage: store,
    requestRender: (reason) => renders.push(reason),
  });
  assert.equal(getPerformancePreset(), 'performance');
  assert.equal(viewer.targetFrameRate, 30);
  assert.equal(viewer.scene.msaaSamples, 1);
  assert.deepEqual(renders, []);
  setPerformancePreset('quality');
  assert.equal(viewer.targetFrameRate, 60);
  assert.equal(viewer.scene.msaaSamples, 4);
  assert.deepEqual(renders, ['performance-preset']);
  uninstall();
  setPerformancePreset('performance');
  assert.equal(viewer.targetFrameRate, 60);
});

test('install without a stored value keeps Balanced and applies its knobs', () => {
  const { viewer } = fakeViewer({ withTileset: false });
  installPerformancePreset(viewer, { storage: storage() });
  assert.equal(getPerformancePreset(), 'balanced');
  assert.equal(
    viewer.scene.msaaSamples,
    PERFORMANCE_PRESETS.balanced.msaaSamples,
  );
  assert.equal(viewer.resolutionScale, 1);
});
