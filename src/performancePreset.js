/**
 * Performance presets — Quality / Balanced / Performance.
 *
 * One device-level choice that sets how much GPU and main-thread work a frame
 * may cost: the drawing-buffer resolution, anti-aliasing, the continuous
 * frame-rate cap, the post-processing the app turns on by itself, how dense
 * the detection overlay solves labels, how often the live layers re-evaluate
 * their fleets, and how much 3D-tile detail and cache the photoreal globe may
 * hold. The default is Balanced.
 *
 * The preset is a property of the machine, not of the view: it is remembered
 * in this browser (like the detection allocation preference) and deliberately
 * kept OUT of share links. A view the preset changed (sharpen, detection
 * density) is still carried by the link as the values themselves, so a
 * recipient sees the same picture at their own preset.
 *
 * Pure module: no DOM, no Cesium import. The viewer, the tileset and the
 * storage are handed in, so the policy is unit-testable and the layers that
 * read the cadence scale stay free of browser globals.
 */

export const PERFORMANCE_PRESET_IDS = Object.freeze([
  'quality',
  'balanced',
  'performance',
]);

export const DEFAULT_PERFORMANCE_PRESET = 'balanced';

/** Browser-local preference key; one value, the preset id. */
export const PERFORMANCE_PRESET_STORAGE_KEY = 'gev:performance-preset:v1';

const MiB = 1024 * 1024;

/**
 * The knobs each preset sets.
 *
 * - `resolutionScale`: Cesium drawing-buffer scale (1 = CSS pixels at DPR 1).
 * - `msaaSamples`: hardware multisampling; 1 turns it off.
 * - `fxaa`: Cesium's post-process anti-aliasing, the cheap stand-in for MSAA.
 * - `targetFrameRate`: cap for the continuous render loop. Idle mode renders
 *   on demand regardless, so this only bounds animated scenes.
 * - `sharpen`: whether the app's own sharpen pass is on. Quality and Balanced
 *   keep the first-load default; Performance drops a full-screen pass.
 * - `detectionDensityPct`: the detection overlay's label density stop.
 * - `cadenceScale`: multiplier on the live layers' re-evaluation intervals
 *   (fleet dead-reckoning, vessel visibility, CCTV view passes, Contacts
 *   readouts). 1 is today's cadence.
 * - `trafficDotScale`: share of the street-traffic dot budget that animates.
 * - `tileMaximumScreenSpaceError` / `tileCacheBytes` /
 *   `tileCacheOverflowBytes`: 3D Tiles refinement and GPU cache for the
 *   photoreal globe. Quality and Balanced keep the SDK's Google defaults.
 */
export const PERFORMANCE_PRESETS = Object.freeze({
  quality: Object.freeze({
    id: 'quality',
    resolutionScale: 1,
    msaaSamples: 4,
    fxaa: false,
    targetFrameRate: 60,
    sharpen: true,
    detectionDensityPct: 75,
    cadenceScale: 1,
    trafficDotScale: 1,
    tileMaximumScreenSpaceError: 16,
    tileCacheBytes: 1536 * MiB,
    tileCacheOverflowBytes: 1024 * MiB,
  }),
  balanced: Object.freeze({
    id: 'balanced',
    resolutionScale: 1,
    msaaSamples: 2,
    fxaa: false,
    targetFrameRate: 60,
    sharpen: true,
    detectionDensityPct: 75,
    cadenceScale: 1,
    trafficDotScale: 1,
    tileMaximumScreenSpaceError: 16,
    tileCacheBytes: 1536 * MiB,
    tileCacheOverflowBytes: 1024 * MiB,
  }),
  performance: Object.freeze({
    id: 'performance',
    resolutionScale: 0.75,
    msaaSamples: 1,
    fxaa: true,
    targetFrameRate: 30,
    sharpen: false,
    detectionDensityPct: 25,
    cadenceScale: 2,
    trafficDotScale: 0.5,
    tileMaximumScreenSpaceError: 24,
    tileCacheBytes: 768 * MiB,
    tileCacheOverflowBytes: 512 * MiB,
  }),
});

let _presetId = DEFAULT_PERFORMANCE_PRESET;
const _listeners = new Set();

/**
 * Canonical preset id for a stored or user-supplied value.
 * @param {unknown} value
 * @param {string|null} [fallback] Returned for anything unknown.
 * @returns {string|null}
 */
export function normalizePerformancePreset(
  value,
  fallback = DEFAULT_PERFORMANCE_PRESET,
) {
  const id = String(value ?? '')
    .trim()
    .toLowerCase();
  return PERFORMANCE_PRESET_IDS.includes(id) ? id : fallback;
}

/** @returns {string} The active preset id. */
export function getPerformancePreset() {
  return _presetId;
}

/** @returns {object} The active preset's frozen settings. */
export function getPerformanceSettings() {
  return PERFORMANCE_PRESETS[_presetId];
}

/**
 * Multiplier the live layers apply to their re-evaluation intervals.
 * Read at use time, never cached across frames, so a preset change takes
 * effect on the next tick without re-arming any timer.
 * @returns {number}
 */
export function performanceCadenceScale() {
  return PERFORMANCE_PRESETS[_presetId].cadenceScale;
}

/**
 * Share of a layer's animated-object budget the active preset allows.
 * @param {number} budget Full budget.
 * @returns {number} Scaled budget, never below one object.
 */
export function performanceScaledBudget(budget) {
  const scaled = Math.round(
    Number(budget) * PERFORMANCE_PRESETS[_presetId].trafficDotScale,
  );
  return Number.isFinite(scaled) ? Math.max(1, scaled) : budget;
}

/**
 * Switch presets. Listeners run only on a real change.
 * @param {string} id
 * @returns {boolean} Whether the preset changed.
 */
export function setPerformancePreset(id) {
  const next = normalizePerformancePreset(id, null);
  if (!next || next === _presetId) return false;
  _presetId = next;
  const settings = PERFORMANCE_PRESETS[next];
  for (const listener of [..._listeners]) {
    try {
      listener(next, settings);
    } catch (error) {
      console.warn('[Performance] preset listener failed', error);
    }
  }
  return true;
}

/**
 * Subscribe to preset changes.
 * @param {(id: string, settings: object) => void} listener
 * @returns {() => void} Unsubscribe.
 */
export function subscribePerformancePreset(listener) {
  if (typeof listener !== 'function') return () => {};
  _listeners.add(listener);
  return () => {
    _listeners.delete(listener);
  };
}

/**
 * The preset this browser remembers, or null when none or unreadable.
 * @param {{getItem?: Function}|null|undefined} storage e.g. localStorage.
 * @returns {string|null}
 */
export function readStoredPerformancePreset(storage) {
  try {
    return normalizePerformancePreset(
      storage?.getItem?.(PERFORMANCE_PRESET_STORAGE_KEY),
      null,
    );
  } catch {
    return null;
  }
}

/**
 * Remember a preset in this browser. Best effort.
 * @param {string} id
 * @param {{setItem?: Function}|null|undefined} storage
 * @returns {boolean} Whether the value was written.
 */
export function persistPerformancePreset(id, storage) {
  const normalized = normalizePerformancePreset(id, null);
  if (!normalized) return false;
  try {
    storage?.setItem?.(PERFORMANCE_PRESET_STORAGE_KEY, normalized);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write a preset's scene knobs onto a Cesium viewer (and the photoreal
 * tileset when there is one). Every write is guarded so a partial viewer
 * (tests, a destroyed scene) is tolerated, and only changed values are
 * written so re-applying the same preset is free.
 * @param {object} viewer Cesium.Viewer-like object.
 * @param {object} settings One of PERFORMANCE_PRESETS.
 * @param {{tileset?: object|null}} [options]
 * @returns {string[]} The knob names that changed.
 */
export function applyPerformanceSettingsToScene(
  viewer,
  settings,
  { tileset = null } = {},
) {
  const changed = [];
  if (!viewer || !settings) return changed;
  const write = (target, key, value, name = key) => {
    if (!target || value === undefined) return;
    try {
      if (target[key] === value) return;
      target[key] = value;
      changed.push(name);
    } catch (error) {
      console.warn(`[Performance] could not set ${name}`, error);
    }
  };
  write(viewer, 'resolutionScale', settings.resolutionScale);
  write(viewer, 'targetFrameRate', settings.targetFrameRate);
  const scene = viewer.scene;
  write(scene, 'msaaSamples', settings.msaaSamples);
  write(scene?.postProcessStages?.fxaa, 'enabled', settings.fxaa, 'fxaa');
  if (tileset && !tileset.isDestroyed?.()) {
    write(
      tileset,
      'maximumScreenSpaceError',
      settings.tileMaximumScreenSpaceError,
    );
    write(tileset, 'cacheBytes', settings.tileCacheBytes);
    write(
      tileset,
      'maximumCacheOverflowBytes',
      settings.tileCacheOverflowBytes,
    );
  }
  return changed;
}

/**
 * Adopt the remembered preset and keep the viewer's scene knobs in step with
 * it for the viewer's lifetime.
 * @param {object} viewer Cesium viewer.
 * @param {object} [options]
 * @param {object|null} [options.tileset] The photoreal tileset, if loaded.
 * @param {object|null} [options.storage] localStorage or a stand-in.
 * @param {(reason: string) => void} [options.requestRender] One-shot render
 *   request so a preset change shows without waiting for camera input.
 * @returns {() => void} Uninstall.
 */
export function installPerformancePreset(
  viewer,
  { tileset = null, storage = null, requestRender = () => {} } = {},
) {
  const stored = readStoredPerformancePreset(storage);
  if (stored) setPerformancePreset(stored);
  applyPerformanceSettingsToScene(viewer, getPerformanceSettings(), {
    tileset,
  });
  const unsubscribe = subscribePerformancePreset((id, settings) => {
    const changed = applyPerformanceSettingsToScene(viewer, settings, {
      tileset,
    });
    if (changed.length) requestRender('performance-preset');
  });
  return unsubscribe;
}

/** Test seam: reset module state between unit tests. */
export function _resetPerformancePresetForTest() {
  _presetId = DEFAULT_PERFORMANCE_PRESET;
  _listeners.clear();
}
