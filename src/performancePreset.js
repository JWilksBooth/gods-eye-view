/**
 * Performance presets — Quality / Balanced / Performance.
 *
 * One device-level choice that sets how sharp a frame is and how much GPU and
 * main-thread work it may cost: the drawing-buffer resolution in device
 * pixels, anti-aliasing, the continuous frame-rate cap, whether the app's own
 * sharpen pass may run, the globe's imagery detail, anisotropic filtering and
 * tile cache, the photoreal 3D-tile detail and cache, how dense the detection
 * overlay solves labels, and how often the live layers re-evaluate their
 * fleets. The default is Balanced; a software rasterizer starts on
 * Performance.
 *
 * Sharpness. Three Cesium defaults made the globe soft on a sharp monitor:
 * the viewer drew at CSS resolution (`useBrowserRecommendedResolution`), so a
 * HiDPI window was upscaled by the browser; the globe's
 * `maximumScreenSpaceError` of 2 let one imagery texel cover two screen
 * pixels; and a `tileCacheSize` of 100 released the previous view's tiles, so
 * every return re-requested them. Each preset now sizes the drawing buffer in
 * device pixels (`pixelRatio`, clamped to the GPU's texture limit on every
 * Cesium resize) and asks for imagery and 3D tiles to match.
 *
 * The preset is a property of the machine, not of the view: it is remembered
 * in this browser (like the detection allocation preference) and deliberately
 * kept OUT of share links. `?quality=<preset>` picks one for a single page
 * load without remembering it. A view the preset changed (detection density)
 * is still carried by the link as the values themselves, so a recipient sees
 * the same picture at their own preset; the sharpen pass is withheld, never
 * switched off, so the operator's sharpen setting is what a link carries.
 *
 * Pure module: no DOM, no Cesium import. The viewer, the tileset, the storage
 * and the GPU limits are handed in, so the policy is unit-testable and the
 * layers that read the cadence scale stay free of browser globals.
 */

export const PERFORMANCE_PRESET_IDS = Object.freeze([
  'quality',
  'balanced',
  'performance',
]);

export const DEFAULT_PERFORMANCE_PRESET = 'balanced';

/** Browser-local preference key; one value, the preset id. */
export const PERFORMANCE_PRESET_STORAGE_KEY = 'gev:performance-preset:v1';

/** `?quality=<preset>` selects a preset for this page load only. */
export const PERFORMANCE_PRESET_QUERY_PARAM = 'quality';

const MiB = 1024 * 1024;

/**
 * The knobs each preset sets.
 *
 * - `pixelRatio`: drawing-buffer device pixels per CSS pixel,
 *   `devicePixelRatio * fraction` bounded by `min` and `max`, then clamped so
 *   neither buffer side exceeds the GPU's texture limit.
 * - `msaaSamples`: hardware multisampling; 1 turns it off.
 * - `fxaa`: Cesium's post-process anti-aliasing, the cheap stand-in for MSAA.
 *   Every preset runs exactly one anti-aliasing pass.
 * - `targetFrameRate`: cap for the continuous render loop. Idle mode renders
 *   on demand regardless, so this only bounds animated scenes.
 * - `sharpenPermitted`: whether the app's own sharpen pass may run. Withheld
 *   only where the browser upscales the buffer; the operator's toggle and
 *   slider keep their values meanwhile.
 * - `detectionDensityPct`: the detection overlay's label density stop.
 * - `cadenceScale`: multiplier on the live layers' re-evaluation intervals
 *   (fleet dead-reckoning, vessel visibility, CCTV view passes, Contacts
 *   readouts). 1 is today's cadence.
 * - `trafficDotScale`: share of the street-traffic dot budget that animates.
 * - `globeMaximumScreenSpaceError` / `globeTileCacheSize`: imagery and terrain
 *   refinement and the tile cache of the globe (every map stack but the
 *   photoreal one). Cesium measures the error in CSS pixels, so a HiDPI buffer
 *   keeps the same tile budget.
 * - `imageryMaximumAnisotropy`: anisotropic filtering cap for the base map's
 *   imagery layer, applied when the layer is built.
 * - `tile*`: the photoreal tileset's screen-space error, the horizon
 *   relaxation of `dynamicScreenSpaceError`, `skipLevelOfDetail`, and its GPU
 *   cache.
 */
export const PERFORMANCE_PRESETS = Object.freeze({
  quality: Object.freeze({
    id: 'quality',
    // Every device pixel, at most two per CSS pixel (a DPR 3 phone draws at 2).
    pixelRatio: Object.freeze({ fraction: 1, min: 1, max: 2 }),
    msaaSamples: 4,
    fxaa: false,
    targetFrameRate: 60,
    sharpenPermitted: true,
    detectionDensityPct: 75,
    cadenceScale: 1,
    trafficDotScale: 1,
    // One imagery texel per CSS pixel instead of two.
    globeMaximumScreenSpaceError: 1,
    // Holds the previous view's tiles, so a return makes no new requests.
    globeTileCacheSize: 600,
    imageryMaximumAnisotropy: 16,
    tileMaximumScreenSpaceError: 12,
    tileDynamicScreenSpaceError: true,
    tileDynamicScreenSpaceErrorFactor: 12,
    tileSkipLevelOfDetail: false,
    tileCacheBytes: 2048 * MiB,
    tileCacheOverflowBytes: 1024 * MiB,
  }),
  balanced: Object.freeze({
    id: 'balanced',
    // Three quarters of the device pixels, never below CSS resolution and at
    // most 1.5 per CSS pixel: a 1600 x 900 window at DPR 1 renders 1600 x 900.
    pixelRatio: Object.freeze({ fraction: 0.75, min: 1, max: 1.5 }),
    msaaSamples: 2,
    fxaa: false,
    targetFrameRate: 60,
    sharpenPermitted: true,
    detectionDensityPct: 75,
    cadenceScale: 1,
    trafficDotScale: 1,
    globeMaximumScreenSpaceError: 1.5,
    globeTileCacheSize: 300,
    imageryMaximumAnisotropy: 8,
    // Cesium's defaults for the Google tileset.
    tileMaximumScreenSpaceError: 16,
    tileDynamicScreenSpaceError: true,
    tileDynamicScreenSpaceErrorFactor: 24,
    tileSkipLevelOfDetail: false,
    tileCacheBytes: 1536 * MiB,
    tileCacheOverflowBytes: 1024 * MiB,
  }),
  performance: Object.freeze({
    id: 'performance',
    // Half the device pixels, between three quarters of CSS resolution and
    // CSS resolution. The browser upscales the result, so sharpen is withheld:
    // it would sharpen the upscale, not the scene.
    pixelRatio: Object.freeze({ fraction: 0.5, min: 0.75, max: 1 }),
    msaaSamples: 1,
    fxaa: true,
    targetFrameRate: 30,
    sharpenPermitted: false,
    detectionDensityPct: 25,
    cadenceScale: 2,
    trafficDotScale: 0.5,
    // Cesium's globe defaults (no change for a weak GPU).
    globeMaximumScreenSpaceError: 2,
    globeTileCacheSize: 100,
    imageryMaximumAnisotropy: 4,
    tileMaximumScreenSpaceError: 24,
    tileDynamicScreenSpaceError: true,
    tileDynamicScreenSpaceErrorFactor: 32,
    tileSkipLevelOfDetail: true,
    tileCacheBytes: 768 * MiB,
    tileCacheOverflowBytes: 512 * MiB,
  }),
});

let _presetId = DEFAULT_PERFORMANCE_PRESET;
/** Who chose the active preset: null until a page load settles it. */
let _source = null;
/** Whether a settled default has been checked against the WebGL renderer. */
let _rendererChecked = false;
const _listeners = new Set();
const _bufferListeners = new Set();

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

/**
 * @returns {'query'|'stored'|'default'|'user'|null} Who chose the active
 *   preset; null before a page load settles one.
 */
export function getPerformancePresetSource() {
  return _source;
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

function activatePreset(id, source) {
  const next = normalizePerformancePreset(id, null);
  if (!next) return false;
  _source = source;
  if (next === _presetId) return false;
  const previous = PERFORMANCE_PRESETS[_presetId];
  _presetId = next;
  const settings = PERFORMANCE_PRESETS[next];
  for (const listener of [..._listeners]) {
    try {
      listener(next, settings, previous);
    } catch (error) {
      console.warn('[Performance] preset listener failed', error);
    }
  }
  return true;
}

/**
 * Switch presets. Listeners run only on a real change.
 * @param {string} id
 * @returns {boolean} Whether the preset changed.
 */
export function setPerformancePreset(id) {
  return activatePreset(id, 'user');
}

/**
 * Subscribe to preset changes.
 * @param {(id: string, settings: object, previous: object) => void} listener
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
 * Subscribe to drawing-buffer changes of the installed viewer: Cesium resized
 * its canvas (a window resize, a new device pixel ratio or a preset change).
 * @param {(buffer: {width: number, height: number}) => void} listener
 * @returns {() => void} Unsubscribe.
 */
export function subscribeDrawingBuffer(listener) {
  if (typeof listener !== 'function') return () => {};
  _bufferListeners.add(listener);
  return () => {
    _bufferListeners.delete(listener);
  };
}

function notifyDrawingBuffer(buffer) {
  for (const listener of [..._bufferListeners]) {
    try {
      listener(buffer);
    } catch (error) {
      console.warn('[Performance] drawing-buffer listener failed', error);
    }
  }
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
 * The preset a `location.search` string names with `?quality=`.
 * @param {string} [search]
 * @returns {string|null}
 */
export function performancePresetFromSearch(search) {
  try {
    return normalizePerformancePreset(
      new URLSearchParams(String(search ?? '')).get(
        PERFORMANCE_PRESET_QUERY_PARAM,
      ),
      null,
    );
  } catch {
    return null;
  }
}

/** Whether a WebGL renderer string names a software rasterizer. */
export function isSoftwareRenderer(renderer) {
  return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(
    String(renderer ?? ''),
  );
}

/**
 * The unmasked WebGL renderer of a canvas that already has a context, or null
 * when the browser withholds it. Asking the canvas for the context type Cesium
 * created returns that same context; nothing new is allocated.
 * @param {{getContext?: Function}|null|undefined} canvas
 * @returns {string|null}
 */
export function describeWebglRenderer(canvas) {
  try {
    const gl =
      canvas?.getContext?.('webgl2') ?? canvas?.getContext?.('webgl') ?? null;
    if (!gl) return null;
    const info = gl.getExtension?.('WEBGL_debug_renderer_info');
    const renderer = info
      ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter?.(gl.RENDERER);
    return typeof renderer === 'string' && renderer ? renderer : null;
  } catch {
    return null;
  }
}

/**
 * Pick the preset a page load starts on: `?quality=` wins, then the
 * remembered choice, then Performance on a software rasterizer, else
 * Balanced.
 * @param {{query?: unknown, stored?: unknown, softwareRenderer?: boolean}} [signals]
 * @returns {{id: string, source: 'query'|'stored'|'default'}}
 */
export function choosePerformancePreset({
  query = null,
  stored = null,
  softwareRenderer = false,
} = {}) {
  const fromQuery = normalizePerformancePreset(query, null);
  if (fromQuery) return { id: fromQuery, source: 'query' };
  const fromStorage = normalizePerformancePreset(stored, null);
  if (fromStorage) return { id: fromStorage, source: 'stored' };
  if (softwareRenderer) return { id: 'performance', source: 'default' };
  return { id: DEFAULT_PERFORMANCE_PRESET, source: 'default' };
}

/**
 * Settle the page load's preset once. Whoever asks first decides (the viewer
 * in the application, which also knows the WebGL renderer) and later callers
 * keep that choice, so a `?quality=` override is never replaced by the
 * remembered value. A settled default that was chosen before the renderer was
 * known still drops to Performance when a later caller reports a software
 * rasterizer.
 * @param {{search?: string, storage?: object|null, renderer?: string|null}} [signals]
 * @returns {{id: string, source: string}}
 */
export function adoptInitialPerformancePreset({
  search = '',
  storage = null,
  renderer = null,
} = {}) {
  if (_source === null) {
    const choice = choosePerformancePreset({
      query: performancePresetFromSearch(search),
      stored: readStoredPerformancePreset(storage),
      softwareRenderer: isSoftwareRenderer(renderer),
    });
    activatePreset(choice.id, choice.source);
    if (renderer) _rendererChecked = true;
  } else if (_source === 'default' && !_rendererChecked && renderer) {
    _rendererChecked = true;
    if (isSoftwareRenderer(renderer)) activatePreset('performance', 'default');
  }
  return { id: _presetId, source: _source };
}

function positiveOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/**
 * Device pixels per CSS pixel a preset asks for at a device pixel ratio,
 * before hardware limits.
 * @param {object} settings One of PERFORMANCE_PRESETS.
 * @param {number} devicePixelRatio
 * @returns {number}
 */
export function presetPixelRatio(settings, devicePixelRatio) {
  const dpr = positiveOr(devicePixelRatio, 1);
  const { fraction = 1, min = 0, max = Infinity } = settings?.pixelRatio ?? {};
  return Math.min(max, Math.max(min, dpr * fraction));
}

/**
 * Resolve the drawing-buffer pixel ratio for a viewport. The preset's ratio
 * is capped so neither buffer side exceeds the GPU's texture limit: a
 * framebuffer above it throws inside Cesium and stops rendering.
 *
 * Cesium sizes the buffer `clientSize * devicePixelRatio * resolutionScale`
 * once `useBrowserRecommendedResolution` is false, so the returned
 * `resolutionScale` is the ratio divided by the device pixel ratio.
 * @param {object} settings One of PERFORMANCE_PRESETS.
 * @param {{devicePixelRatio?: number, clientWidth?: number, clientHeight?: number, maxTextureSize?: number}} [viewport]
 * @returns {{pixelRatio: number, wanted: number, resolutionScale: number, clampedBy: 'texture-size'|null, drawingBuffer: {width: number, height: number}}}
 */
export function resolvePixelRatio(
  settings,
  {
    devicePixelRatio = 1,
    clientWidth = 0,
    clientHeight = 0,
    maxTextureSize = Infinity,
  } = {},
) {
  const dpr = positiveOr(devicePixelRatio, 1);
  const wanted = presetPixelRatio(settings, dpr);
  const width = positiveOr(clientWidth, 0);
  const height = positiveOr(clientHeight, 0);
  const longest = Math.max(width, height);
  const limit = positiveOr(maxTextureSize, Infinity);
  let pixelRatio = wanted;
  let clampedBy = null;
  if (longest > 0 && Number.isFinite(limit) && pixelRatio * longest > limit) {
    pixelRatio = limit / longest;
    clampedBy = 'texture-size';
  }
  return {
    pixelRatio,
    wanted,
    resolutionScale: pixelRatio / dpr,
    clampedBy,
    drawingBuffer: {
      width: Math.floor(width * pixelRatio),
      height: Math.floor(height * pixelRatio),
    },
  };
}

function guardedWriter(changed) {
  return (target, key, value, name = key) => {
    if (!target || value === undefined) return;
    try {
      if (target[key] === value) return;
      target[key] = value;
      changed.push(name);
    } catch (error) {
      console.warn(`[Performance] could not set ${name}`, error);
    }
  };
}

/**
 * Write a preset's photoreal-tileset knobs. Every one is runtime-settable, so
 * a hidden or still-loading tileset takes them as well as a shown one.
 * @param {object|null|undefined} tileset Cesium3DTileset-like object.
 * @param {object} settings One of PERFORMANCE_PRESETS.
 * @returns {string[]} The knob names that changed.
 */
export function applyPerformanceSettingsToTileset(tileset, settings) {
  const changed = [];
  if (!tileset || !settings || tileset.isDestroyed?.() === true) return changed;
  const write = guardedWriter(changed);
  write(
    tileset,
    'maximumScreenSpaceError',
    settings.tileMaximumScreenSpaceError,
  );
  write(
    tileset,
    'dynamicScreenSpaceError',
    settings.tileDynamicScreenSpaceError,
  );
  write(
    tileset,
    'dynamicScreenSpaceErrorFactor',
    settings.tileDynamicScreenSpaceErrorFactor,
  );
  write(tileset, 'skipLevelOfDetail', settings.tileSkipLevelOfDetail);
  write(tileset, 'cacheBytes', settings.tileCacheBytes);
  write(tileset, 'maximumCacheOverflowBytes', settings.tileCacheOverflowBytes);
  return changed;
}

function viewportOf(viewer, overrides = {}) {
  const canvas = viewer?.canvas;
  return {
    devicePixelRatio: positiveOr(globalThis.devicePixelRatio, 1),
    clientWidth: canvas?.clientWidth ?? 0,
    clientHeight: canvas?.clientHeight ?? 0,
    maxTextureSize: Infinity,
    ...overrides,
  };
}

/**
 * Bring the viewer's drawing buffer in line with a preset: device pixels
 * (`useBrowserRecommendedResolution` off) scaled to the preset's ratio and
 * clamped to the texture limit. Cheap when nothing changed, so it can run
 * before every Cesium resize.
 * @param {object} viewer Cesium.Viewer-like object.
 * @param {object} settings One of PERFORMANCE_PRESETS.
 * @param {object} [viewport] See resolvePixelRatio; defaults to the canvas.
 * @param {string[]} [changed] Collects the knob names written.
 * @returns {ReturnType<typeof resolvePixelRatio>|null}
 */
export function enforcePerformanceResolution(
  viewer,
  settings,
  viewport = viewportOf(viewer),
  changed = [],
) {
  if (!viewer || !settings) return null;
  const resolution = resolvePixelRatio(settings, viewport);
  const write = guardedWriter(changed);
  write(viewer, 'useBrowserRecommendedResolution', false);
  const current = Number(viewer.resolutionScale);
  if (
    resolution.resolutionScale > 0 &&
    !(Math.abs(current - resolution.resolutionScale) <= 1e-6)
  )
    write(viewer, 'resolutionScale', resolution.resolutionScale);
  return resolution;
}

/**
 * Write a preset's scene knobs onto a Cesium viewer (and the photoreal
 * tileset when there is one). Every write is guarded so a partial viewer
 * (tests, a destroyed scene) is tolerated, and only changed values are
 * written so re-applying the same preset is free.
 * @param {object} viewer Cesium.Viewer-like object.
 * @param {object} settings One of PERFORMANCE_PRESETS.
 * @param {{tileset?: object|null, viewport?: object}} [options]
 * @returns {string[]} The knob names that changed.
 */
export function applyPerformanceSettingsToScene(
  viewer,
  settings,
  { tileset = null, viewport = viewportOf(viewer) } = {},
) {
  const changed = [];
  if (!viewer || !settings) return changed;
  const write = guardedWriter(changed);
  enforcePerformanceResolution(viewer, settings, viewport, changed);
  write(viewer, 'targetFrameRate', settings.targetFrameRate);
  const scene = viewer.scene;
  write(scene, 'msaaSamples', settings.msaaSamples);
  write(scene?.postProcessStages?.fxaa, 'enabled', settings.fxaa, 'fxaa');
  write(
    scene?.globe,
    'maximumScreenSpaceError',
    settings.globeMaximumScreenSpaceError,
    'globeMaximumScreenSpaceError',
  );
  write(
    scene?.globe,
    'tileCacheSize',
    settings.globeTileCacheSize,
    'globeTileCacheSize',
  );
  changed.push(...applyPerformanceSettingsToTileset(tileset, settings));
  return changed;
}

/**
 * Rebuild the base map's imagery when a preset change alters its anisotropy
 * cap: Cesium fixes a tile's sampler when its texture uploads, so only a new
 * layer picks the new cap up.
 * @param {() => unknown} refresh e.g. `() => mapStackController.refreshImageryLayer()`.
 * @returns {() => void} Unsubscribe.
 */
export function refreshImageryOnAnisotropyChange(refresh) {
  if (typeof refresh !== 'function') return () => {};
  return subscribePerformancePreset((id, settings, previous) => {
    if (
      settings?.imageryMaximumAnisotropy !== previous?.imageryMaximumAnisotropy
    )
      refresh();
  });
}

/**
 * Settle the page load's preset and keep the viewer's render knobs in step
 * with it for the viewer's lifetime: resolution, anti-aliasing, frame-rate
 * cap and globe detail now, the photoreal tileset once attached, and the
 * texture-limit clamp before every Cesium resize.
 *
 * Call it right after the viewer is constructed, before its first frame.
 * @param {object} viewer Cesium viewer.
 * @param {object} [options]
 * @param {object|null} [options.tileset] The photoreal tileset, if loaded.
 * @param {object|null} [options.storage] localStorage or a stand-in.
 * @param {string} [options.search] `location.search`, for `?quality=`.
 * @param {string|null} [options.renderer] The unmasked WebGL renderer;
 *   probed from the viewer's canvas when omitted.
 * @param {(reason: string) => void} [options.requestRender] One-shot render
 *   request so a preset change shows without waiting for camera input.
 * @param {() => number} [options.getMaxTextureSize] The GPU's texture and
 *   renderbuffer side limit.
 * @param {() => number} [options.getDevicePixelRatio]
 * @returns {{attachTileset(tileset: object): () => void, describe(): object, uninstall(): void}}
 */
export function installPerformancePreset(
  viewer,
  {
    tileset = null,
    storage = null,
    search = '',
    renderer,
    requestRender = () => {},
    getMaxTextureSize = () => Infinity,
    getDevicePixelRatio = () => positiveOr(globalThis.devicePixelRatio, 1),
  } = {},
) {
  const rendererName =
    renderer === undefined ? describeWebglRenderer(viewer?.canvas) : renderer;
  adoptInitialPerformancePreset({ search, storage, renderer: rendererName });
  const tilesets = new Set();
  let lastResolution = null;
  let lastBuffer = null;
  let installed = true;

  const viewport = () =>
    viewportOf(viewer, {
      devicePixelRatio: getDevicePixelRatio(),
      maxTextureSize: getMaxTextureSize(),
    });
  const apply = (settings) => {
    const current = viewport();
    const changed = applyPerformanceSettingsToScene(viewer, settings, {
      viewport: current,
    });
    lastResolution = resolvePixelRatio(settings, current);
    for (const attached of tilesets)
      changed.push(...applyPerformanceSettingsToTileset(attached, settings));
    return changed;
  };

  // Cesium's render loop calls `resize()` before every frame; clamping there
  // keeps a window that grows past the texture limit (or moves to a denser
  // screen) from ever allocating a framebuffer above it. The inputs are
  // compared first, so a steady frame allocates nothing.
  const seen = { dpr: NaN, width: NaN, height: NaN, limit: NaN, id: null };
  const enforceIfChanged = () => {
    const canvas = viewer?.canvas;
    const dpr = getDevicePixelRatio();
    const width = canvas?.clientWidth ?? 0;
    const height = canvas?.clientHeight ?? 0;
    const limit = getMaxTextureSize();
    const id = getPerformancePreset();
    if (
      dpr === seen.dpr &&
      width === seen.width &&
      height === seen.height &&
      limit === seen.limit &&
      id === seen.id &&
      Math.abs(viewer?.resolutionScale - lastResolution?.resolutionScale) <=
        1e-6
    )
      return;
    Object.assign(seen, { dpr, width, height, limit, id });
    lastResolution = enforcePerformanceResolution(
      viewer,
      getPerformanceSettings(),
      viewport(),
    );
  };
  const widget = viewer?.cesiumWidget ?? viewer;
  const originalResize = widget?.resize;
  let restoreResize = () => {};
  if (typeof originalResize === 'function') {
    const wrappedResize = function performancePresetResize() {
      if (installed) enforceIfChanged();
      // CesiumWidget#resize takes no arguments.
      const result = originalResize.call(this);
      const width = viewer?.canvas?.width ?? 0;
      const height = viewer?.canvas?.height ?? 0;
      if (
        installed &&
        (width !== lastBuffer?.width || height !== lastBuffer?.height)
      ) {
        lastBuffer = { width, height };
        notifyDrawingBuffer({ width, height });
      }
      return result;
    };
    widget.resize = wrappedResize;
    restoreResize = () => {
      if (widget.resize === wrappedResize) widget.resize = originalResize;
    };
  }

  if (tileset) tilesets.add(tileset);
  apply(getPerformanceSettings());
  const unsubscribe = subscribePerformancePreset((id, settings) => {
    const changed = apply(settings);
    if (changed.length) requestRender('performance-preset');
  });

  return {
    /**
     * Apply the active preset to a tileset now and on every later change.
     * @param {object} next Cesium3DTileset-like object.
     * @returns {() => void} Detach.
     */
    attachTileset(next) {
      if (!installed || !next) return () => {};
      tilesets.add(next);
      const changed = applyPerformanceSettingsToTileset(
        next,
        getPerformanceSettings(),
      );
      if (changed.length) requestRender('performance-preset');
      return () => {
        tilesets.delete(next);
      };
    },
    /** A snapshot for the Display readout, the QA harness and bug reports. */
    describe() {
      const settings = getPerformanceSettings();
      const canvas = viewer?.canvas;
      const scene = viewer?.scene;
      const resolution =
        lastResolution ?? resolvePixelRatio(settings, viewport());
      const [firstTileset] = tilesets;
      return {
        preset: getPerformancePreset(),
        source: getPerformancePresetSource(),
        renderer: rendererName ?? null,
        softwareRenderer: isSoftwareRenderer(rendererName),
        devicePixelRatio: getDevicePixelRatio(),
        cssViewport: {
          width: canvas?.clientWidth ?? 0,
          height: canvas?.clientHeight ?? 0,
        },
        drawingBuffer: {
          width: canvas?.width ?? 0,
          height: canvas?.height ?? 0,
        },
        pixelRatio: resolution.pixelRatio,
        wantedPixelRatio: resolution.wanted,
        clampedBy: resolution.clampedBy,
        maxTextureSize: getMaxTextureSize(),
        resolutionScale: viewer?.resolutionScale ?? null,
        useBrowserRecommendedResolution:
          viewer?.useBrowserRecommendedResolution ?? null,
        msaaSamples: scene?.msaaSamples ?? settings.msaaSamples,
        fxaa: scene?.postProcessStages?.fxaa?.enabled ?? settings.fxaa,
        targetFrameRate: viewer?.targetFrameRate ?? settings.targetFrameRate,
        sharpenPermitted: settings.sharpenPermitted,
        globe: {
          maximumScreenSpaceError:
            scene?.globe?.maximumScreenSpaceError ??
            settings.globeMaximumScreenSpaceError,
          tileCacheSize:
            scene?.globe?.tileCacheSize ?? settings.globeTileCacheSize,
        },
        imageryMaximumAnisotropy: settings.imageryMaximumAnisotropy,
        tileset: firstTileset
          ? {
              maximumScreenSpaceError: firstTileset.maximumScreenSpaceError,
              dynamicScreenSpaceError: firstTileset.dynamicScreenSpaceError,
              dynamicScreenSpaceErrorFactor:
                firstTileset.dynamicScreenSpaceErrorFactor,
              skipLevelOfDetail: firstTileset.skipLevelOfDetail,
              cacheBytes: firstTileset.cacheBytes,
              maximumCacheOverflowBytes: firstTileset.maximumCacheOverflowBytes,
            }
          : null,
      };
    },
    uninstall() {
      if (!installed) return;
      installed = false;
      unsubscribe();
      restoreResize();
      tilesets.clear();
    },
  };
}

/** Test seam: reset module state between unit tests. */
export function _resetPerformancePresetForTest() {
  _presetId = DEFAULT_PERFORMANCE_PRESET;
  _source = null;
  _rendererChecked = false;
  _listeners.clear();
  _bufferListeners.clear();
}
