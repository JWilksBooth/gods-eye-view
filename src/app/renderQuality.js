/**
 * Render-quality presets: Quality, Balanced and Performance.
 *
 * Three Cesium defaults made the globe look soft on a sharp monitor. The
 * viewer drew at CSS resolution (`useBrowserRecommendedResolution`), so a
 * HiDPI window was upscaled by the browser. The globe's
 * `maximumScreenSpaceError` of 2 let one imagery texel cover two screen
 * pixels, so imagery arrived a level too coarse even at device resolution.
 * And a `tileCacheSize` of 100 released the previous view's tiles, so every
 * return to a view re-requested them.
 *
 * A preset bundles every knob the renderer exposes for the sharpness versus
 * frame-time trade: the drawing-buffer pixel ratio, MSAA and FXAA, the
 * globe's screen-space error and tile cache, imagery anisotropy, the Google
 * Photorealistic 3D Tiles budget, and whether the sharpen stage may run (an
 * unsharp mask over a browser-upscaled buffer adds noise, not detail). The
 * presets and their measured cost are documented in docs/PERFORMANCE.md.
 *
 * This module is Cesium-free so it can be tested against plain objects. The
 * controller writes to a live viewer through the properties Cesium exposes at
 * runtime, so a preset can change without rebuilding the WebGL context.
 */

export const RENDER_QUALITY_NAMES = Object.freeze([
  'quality',
  'balanced',
  'performance',
]);

/** The preset a capable desktop starts on; the heuristic in `chooseRenderQuality` lowers it. */
export const RENDER_QUALITY_DEFAULT = 'quality';

/** Remembered choice; the value is a preset name. */
export const RENDER_QUALITY_STORAGE_KEY = 'gev:render-quality:v1';

/** `?quality=<preset>` selects a preset for this page load without remembering it. */
export const RENDER_QUALITY_QUERY_PARAM = 'quality';

const MiB = 1024 * 1024;

/**
 * @typedef {object} RenderQualityPreset
 * @property {string} name
 * @property {{fraction?: number, min?: number, max?: number}} pixelRatio
 *   Drawing-buffer device pixels per CSS pixel: `devicePixelRatio * fraction`,
 *   bounded by `min` and `max`.
 * @property {number} msaaSamples `scene.msaaSamples`; 1 disables MSAA.
 * @property {boolean} fxaa Whether the FXAA post-process stage runs.
 * @property {boolean} sharpenPermitted Whether the Display sharpen stage may run.
 * @property {{maximumScreenSpaceError: number, tileCacheSize: number}} globe
 * @property {{maximumAnisotropy: number}} imagery Anisotropic filtering cap for imagery layers.
 * @property {object} tileset Cesium3DTileset properties for Google Photorealistic 3D Tiles.
 */

/** @type {Readonly<Record<string, RenderQualityPreset>>} */
export const RENDER_QUALITY_PRESETS = Object.freeze({
  quality: Object.freeze({
    name: 'quality',
    // Every device pixel, up to two per CSS pixel; a DPR 3 phone draws at 2.
    pixelRatio: Object.freeze({ fraction: 1, min: 1, max: 2 }),
    msaaSamples: 4,
    fxaa: false,
    sharpenPermitted: true,
    globe: Object.freeze({
      // One imagery texel per CSS pixel (Cesium measures this error in CSS
      // pixels, so a HiDPI buffer keeps the same tile budget).
      maximumScreenSpaceError: 1,
      // Holds the previous view's tiles so a return makes no new requests.
      tileCacheSize: 600,
    }),
    imagery: Object.freeze({ maximumAnisotropy: 16 }),
    tileset: Object.freeze({
      maximumScreenSpaceError: 12,
      dynamicScreenSpaceError: true,
      dynamicScreenSpaceErrorFactor: 12,
      skipLevelOfDetail: false,
      preloadWhenHidden: false,
      cacheBytes: 2048 * MiB,
      maximumCacheOverflowBytes: 1024 * MiB,
    }),
  }),
  balanced: Object.freeze({
    name: 'balanced',
    // Three quarters of the device pixels on HiDPI, never below CSS
    // resolution, and at most 1.5 per CSS pixel.
    pixelRatio: Object.freeze({ fraction: 0.75, min: 1, max: 1.5 }),
    msaaSamples: 4,
    fxaa: false,
    sharpenPermitted: true,
    globe: Object.freeze({ maximumScreenSpaceError: 1.5, tileCacheSize: 300 }),
    imagery: Object.freeze({ maximumAnisotropy: 16 }),
    tileset: Object.freeze({
      // Cesium's defaults for the Google tileset.
      maximumScreenSpaceError: 16,
      dynamicScreenSpaceError: true,
      dynamicScreenSpaceErrorFactor: 24,
      skipLevelOfDetail: false,
      preloadWhenHidden: false,
      cacheBytes: 1536 * MiB,
      maximumCacheOverflowBytes: 1024 * MiB,
    }),
  }),
  performance: Object.freeze({
    name: 'performance',
    // Half the device pixels, between three quarters of CSS resolution and
    // CSS resolution. The browser upscales the result, so sharpen stays off.
    pixelRatio: Object.freeze({ fraction: 0.5, min: 0.75, max: 1 }),
    msaaSamples: 1,
    fxaa: true,
    sharpenPermitted: false,
    globe: Object.freeze({ maximumScreenSpaceError: 2, tileCacheSize: 100 }),
    imagery: Object.freeze({ maximumAnisotropy: 4 }),
    tileset: Object.freeze({
      maximumScreenSpaceError: 24,
      dynamicScreenSpaceError: true,
      dynamicScreenSpaceErrorFactor: 32,
      skipLevelOfDetail: true,
      preloadWhenHidden: false,
      cacheBytes: 768 * MiB,
      maximumCacheOverflowBytes: 512 * MiB,
    }),
  }),
});

/**
 * @param {unknown} name
 * @returns {string|null} The preset name, or null for anything else.
 */
export function normalizeRenderQuality(name) {
  const key = String(name ?? '')
    .trim()
    .toLowerCase();
  return RENDER_QUALITY_NAMES.includes(key) ? key : null;
}

/**
 * @param {unknown} name
 * @returns {RenderQualityPreset} The named preset, or the default for an unknown name.
 */
export function renderQualityPreset(name) {
  return RENDER_QUALITY_PRESETS[
    normalizeRenderQuality(name) ?? RENDER_QUALITY_DEFAULT
  ];
}

/** Whether a WebGL renderer string names a software rasterizer. */
export function isSoftwareRenderer(renderer) {
  return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(
    String(renderer ?? ''),
  );
}

/**
 * The unmasked WebGL renderer of a canvas that already has a context, or
 * null when the browser withholds it. Asking the canvas for the context type
 * Cesium created returns that same context; nothing new is allocated.
 * @param {HTMLCanvasElement|null|undefined} canvas
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
 * Read the preset `?quality=` names in a `location.search` string.
 * @param {string} [search]
 * @returns {string|null}
 */
export function renderQualityFromSearch(search) {
  try {
    const params = new URLSearchParams(String(search ?? ''));
    return normalizeRenderQuality(
      params.get(RENDER_QUALITY_QUERY_PARAM) ?? params.get('renderQuality'),
    );
  } catch {
    return null;
  }
}

/**
 * Read the remembered preset. Storage can be missing or throw (private
 * windows, blocked site data); both read as no preference.
 * @param {Storage|null|undefined} storage
 * @returns {string|null}
 */
export function readStoredRenderQuality(storage) {
  try {
    return normalizeRenderQuality(storage?.getItem?.(RENDER_QUALITY_STORAGE_KEY));
  } catch {
    return null;
  }
}

/**
 * Remember a preset. Returns whether the write happened.
 * @param {Storage|null|undefined} storage
 * @param {string} name
 * @returns {boolean}
 */
export function writeStoredRenderQuality(storage, name) {
  const key = normalizeRenderQuality(name);
  if (!key || !storage?.setItem) return false;
  try {
    storage.setItem(RENDER_QUALITY_STORAGE_KEY, key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pick the preset a page load starts on. An explicit `?quality=` wins, then
 * the remembered choice; otherwise a software rasterizer gets Performance, a
 * touch-first screen (whose pixel ratio is usually 2 or 3) gets Balanced, and
 * everything else gets Quality.
 * @param {{query?: string|null, stored?: string|null, softwareRenderer?: boolean, coarsePointer?: boolean}} [signals]
 * @returns {{name: string, source: 'query'|'stored'|'default'}}
 */
export function chooseRenderQuality({
  query = null,
  stored = null,
  softwareRenderer = false,
  coarsePointer = false,
} = {}) {
  const fromQuery = normalizeRenderQuality(query);
  if (fromQuery) return { name: fromQuery, source: 'query' };
  const fromStorage = normalizeRenderQuality(stored);
  if (fromStorage) return { name: fromStorage, source: 'stored' };
  if (softwareRenderer) return { name: 'performance', source: 'default' };
  if (coarsePointer) return { name: 'balanced', source: 'default' };
  return { name: RENDER_QUALITY_DEFAULT, source: 'default' };
}

function positiveOr(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Device pixels per CSS pixel a preset asks for at a device pixel ratio,
 * before hardware limits.
 * @param {RenderQualityPreset} preset
 * @param {number} devicePixelRatio
 * @returns {number}
 */
export function presetPixelRatio(preset, devicePixelRatio) {
  const dpr = positiveOr(devicePixelRatio, 1);
  const { fraction = 1, min = 0, max = Infinity } = preset.pixelRatio ?? {};
  return Math.min(max, Math.max(min, dpr * fraction));
}

/**
 * Resolve the drawing-buffer pixel ratio for a viewport. The preset's ratio
 * is capped so neither buffer side exceeds the GPU's texture limit; a
 * framebuffer above it throws inside Cesium and stops rendering.
 *
 * Cesium's buffer is `clientSize * devicePixelRatio * resolutionScale` when
 * `useBrowserRecommendedResolution` is false, so the returned
 * `resolutionScale` is the ratio divided by the device pixel ratio.
 * @param {RenderQualityPreset} preset
 * @param {{devicePixelRatio?: number, clientWidth?: number, clientHeight?: number, maxTextureSize?: number}} [viewport]
 * @returns {{pixelRatio: number, wanted: number, resolutionScale: number, clampedBy: 'texture-size'|null, drawingBuffer: {width: number, height: number}}}
 */
export function resolvePixelRatio(
  preset,
  {
    devicePixelRatio = 1,
    clientWidth = 0,
    clientHeight = 0,
    maxTextureSize = Infinity,
  } = {},
) {
  const dpr = positiveOr(devicePixelRatio, 1);
  const wanted = presetPixelRatio(preset, dpr);
  const longest = Math.max(positiveOr(clientWidth, 0), positiveOr(clientHeight, 0));
  let pixelRatio = wanted;
  let clampedBy = null;
  const limit = positiveOr(maxTextureSize, Infinity);
  if (longest > 0 && Number.isFinite(limit) && pixelRatio > limit / longest) {
    pixelRatio = limit / longest;
    clampedBy = 'texture-size';
  }
  return {
    pixelRatio,
    wanted,
    resolutionScale: pixelRatio / dpr,
    clampedBy,
    drawingBuffer: {
      width: Math.floor(positiveOr(clientWidth, 0) * pixelRatio),
      height: Math.floor(positiveOr(clientHeight, 0) * pixelRatio),
    },
  };
}

/**
 * Write a preset's Cesium3DTileset properties. Every one is runtime-settable,
 * so a hidden or loading tileset takes them as well as a shown one.
 * @param {object|null|undefined} tileset
 * @param {RenderQualityPreset} preset
 * @returns {boolean} Whether a tileset was written.
 */
export function applyRenderQualityToTileset(tileset, preset) {
  if (!tileset || tileset.isDestroyed?.() === true) return false;
  for (const [key, value] of Object.entries(preset.tileset)) tileset[key] = value;
  return true;
}

/**
 * Own the active preset for one viewer: choose it, write it to the viewer and
 * attached tilesets, keep the drawing buffer inside the GPU's texture limit
 * on every resize, remember the operator's choice and tell listeners.
 *
 * `attach` is separate from construction so the chosen preset can shape the
 * viewer's constructor options (MSAA samples) before any frame renders.
 * @param {object} [options]
 * @param {Storage|null} [options.storage] Where the choice is remembered.
 * @param {string} [options.search] `location.search`, for `?quality=`.
 * @param {boolean} [options.coarsePointer] `(pointer: coarse)` media match.
 * @param {() => number} [options.getDevicePixelRatio]
 */
export function createRenderQualityController({
  storage = null,
  search = '',
  coarsePointer = false,
  getDevicePixelRatio = () => positiveOr(globalThis.devicePixelRatio, 1),
} = {}) {
  let choice = chooseRenderQuality({
    query: renderQualityFromSearch(search),
    stored: readStoredRenderQuality(storage),
    coarsePointer,
  });
  let name = choice.name;
  let viewer = null;
  let requestRender = () => {};
  let getMaxTextureSize = () => Infinity;
  let renderer = null;
  let restoreResize = () => {};
  let lastResolution = null;
  const tilesets = new Set();
  const listeners = new Set();
  let destroyed = false;

  const preset = () => RENDER_QUALITY_PRESETS[name];

  function viewportSignals() {
    const canvas = viewer?.canvas;
    return {
      devicePixelRatio: getDevicePixelRatio(),
      clientWidth: canvas?.clientWidth ?? 0,
      clientHeight: canvas?.clientHeight ?? 0,
      maxTextureSize: getMaxTextureSize(),
    };
  }

  /** Bring the viewer's resolution in line with the preset; cheap when nothing changed. */
  function enforceResolution() {
    if (!viewer) return null;
    const resolution = resolvePixelRatio(preset(), viewportSignals());
    if (viewer.useBrowserRecommendedResolution !== false)
      viewer.useBrowserRecommendedResolution = false;
    if (
      resolution.resolutionScale > 0 &&
      Math.abs((viewer.resolutionScale ?? 1) - resolution.resolutionScale) >
        1e-6
    )
      viewer.resolutionScale = resolution.resolutionScale;
    lastResolution = resolution;
    return resolution;
  }

  function applyToViewer() {
    if (!viewer) return;
    const active = preset();
    enforceResolution();
    const scene = viewer.scene;
    if (scene) {
      if (scene.msaaSamples !== active.msaaSamples)
        scene.msaaSamples = active.msaaSamples;
      const fxaa = scene.postProcessStages?.fxaa;
      if (fxaa && fxaa.enabled !== active.fxaa) fxaa.enabled = active.fxaa;
      const globe = scene.globe;
      if (globe) {
        globe.maximumScreenSpaceError = active.globe.maximumScreenSpaceError;
        globe.tileCacheSize = active.globe.tileCacheSize;
      }
    }
    for (const tileset of tilesets) applyRenderQualityToTileset(tileset, active);
    requestRender('render-quality');
  }

  function notify(previous) {
    const state = { name, preset: preset(), previous, source: choice.source };
    for (const listener of [...listeners]) {
      try {
        listener(state);
      } catch (error) {
        console.warn('[RenderQuality] listener failed:', error);
      }
    }
  }

  return {
    get name() {
      return name;
    },
    /** @returns {RenderQualityPreset} */
    getPreset: () => preset(),
    /** @returns {'query'|'stored'|'default'} Where the current preset came from. */
    getSource: () => choice.source,
    /**
     * Take over a constructed viewer. Applies the preset before the first
     * frame when called synchronously after construction, probes the WebGL
     * renderer, and lowers a heuristic default to Performance on a software
     * rasterizer. Idempotent per viewer.
     * @param {object} target A Cesium Viewer (or CesiumWidget).
     * @param {{requestRender?: (reason: string) => void, getMaxTextureSize?: () => number, renderer?: string|null}} [hooks]
     */
    attach(target, hooks = {}) {
      if (destroyed || !target || viewer === target) return;
      restoreResize();
      viewer = target;
      requestRender = hooks.requestRender ?? (() => viewer.scene?.requestRender?.());
      getMaxTextureSize = hooks.getMaxTextureSize ?? (() => Infinity);
      renderer =
        hooks.renderer === undefined
          ? describeWebglRenderer(viewer.canvas)
          : hooks.renderer;
      if (choice.source === 'default' && isSoftwareRenderer(renderer)) {
        choice = { name: 'performance', source: 'default' };
        name = choice.name;
      }
      // Cesium's render loop calls `resize()` before every frame; clamping
      // there keeps a window that grows past the texture limit from ever
      // allocating a framebuffer above it.
      const widget = viewer.cesiumWidget ?? viewer;
      const original = widget.resize;
      if (typeof original === 'function') {
        const wrapped = function wrappedResize(...args) {
          enforceResolution();
          return original.apply(this, args);
        };
        widget.resize = wrapped;
        restoreResize = () => {
          if (widget.resize === wrapped) widget.resize = original;
          restoreResize = () => {};
        };
      }
      applyToViewer();
    },
    /**
     * Select a preset. Unknown names are refused; a known one is written to the
     * viewer and attached tilesets, remembered unless `persist` is false, and
     * announced to subscribers even when it is already active (a repaint).
     * @param {string} next
     * @param {{persist?: boolean}} [options]
     * @returns {{ok: boolean, name: string, error?: string}}
     */
    set(next, { persist = true } = {}) {
      const key = normalizeRenderQuality(next);
      if (!key) return { ok: false, name, error: `Unknown render quality: ${next}` };
      if (destroyed) return { ok: false, name, error: 'Render quality is disposed' };
      const previous = preset();
      name = key;
      choice = { name: key, source: persist ? 'stored' : 'query' };
      if (persist) writeStoredRenderQuality(storage, key);
      applyToViewer();
      notify(previous);
      return { ok: true, name };
    },
    /** Apply the preset to a tileset now and on every later change. */
    attachTileset(tileset) {
      if (destroyed || !tileset) return;
      tilesets.add(tileset);
      applyRenderQualityToTileset(tileset, preset());
    },
    detachTileset(tileset) {
      tilesets.delete(tileset);
    },
    /** Re-run the viewer writes, e.g. after another owner changed a shared property. */
    reapply() {
      applyToViewer();
    },
    /**
     * @param {(state: {name: string, preset: RenderQualityPreset, previous: RenderQualityPreset, source: string}) => void} listener
     * @returns {() => void} Unsubscribe.
     */
    subscribe(listener) {
      if (typeof listener !== 'function' || destroyed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** A snapshot for the Display rail, the QA harness and bug reports. */
    describe() {
      const active = preset();
      const resolution = viewer ? enforceResolution() : null;
      const canvas = viewer?.canvas;
      const scene = viewer?.scene;
      return {
        name,
        source: choice.source,
        renderer,
        softwareRenderer: isSoftwareRenderer(renderer),
        devicePixelRatio: getDevicePixelRatio(),
        cssViewport: canvas
          ? { width: canvas.clientWidth ?? 0, height: canvas.clientHeight ?? 0 }
          : null,
        drawingBuffer: canvas
          ? { width: canvas.width ?? 0, height: canvas.height ?? 0 }
          : null,
        pixelRatio: resolution?.pixelRatio ?? presetPixelRatio(active, getDevicePixelRatio()),
        wantedPixelRatio: resolution?.wanted ?? null,
        clampedBy: resolution?.clampedBy ?? null,
        resolutionScale: viewer?.resolutionScale ?? null,
        msaaSamples: scene?.msaaSamples ?? active.msaaSamples,
        fxaa: scene?.postProcessStages?.fxaa?.enabled ?? active.fxaa,
        sharpenPermitted: active.sharpenPermitted,
        globe: scene?.globe
          ? {
              maximumScreenSpaceError: scene.globe.maximumScreenSpaceError,
              tileCacheSize: scene.globe.tileCacheSize,
            }
          : { ...active.globe },
        imagery: { ...active.imagery },
        tileset: { ...active.tileset },
        tilesets: tilesets.size,
        lastResolution,
      };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      restoreResize();
      listeners.clear();
      tilesets.clear();
      viewer = null;
    },
  };
}
