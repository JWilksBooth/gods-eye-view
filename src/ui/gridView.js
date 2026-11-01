import * as Cesium from 'cesium';
import {
  readCameraTargetFrame,
  setCameraTargetFrame,
} from './cameraOrientationControls.js';
import {
  chooseGridSpacing,
  extentOfSamples,
  formatGridDegrees,
  gridCellCenters,
  gridLines,
  gridSpanDeg,
  mgrsPrecisionForSpacing,
  normalizeExtent,
  orthographicFov,
  orthographicFovy,
} from '../gridViewMath.js';
import { mgrsAt } from '../mgrsFormat.js';

/** Browser-local preference: `'1'` while the grid view is on. */
export const GRID_VIEW_STORAGE_KEY = 'gev:grid-view:v1';
/** Body class the stylesheet keys the overlay and button state on. */
export const GRID_VIEW_BODY_CLASS = 'grid-view';
/** The grid canvas element id (src/ui/styles/events.css positions it). */
export const GRID_VIEW_OVERLAY_ID = 'event-grid-overlay';
/**
 * Base map luminance while the grid is on: the photoreal tileset is tinted
 * to this grey and a globe imagery base gets this brightness, so the grid
 * and the event icons read over the imagery. Restored exactly on exit.
 */
export const GRID_VIEW_BASE_LUMINANCE = 0.55;

const STRAIGHT_DOWN = -Cesium.Math.PI_OVER_TWO;
/** The camera counts as straight down and north up within these. */
const PITCH_TOLERANCE = Cesium.Math.toRadians(1);
const HEADING_TOLERANCE = Cesium.Math.toRadians(0.5);
/** Points sampled along each grid line; straight in this view, curved near the limb. */
const LINE_SAMPLES = 16;
/** Fallback field of view when the frustum has no usable size yet. */
const DEFAULT_FOVY = Cesium.Math.toRadians(60);
const MAX_PIXEL_RATIO = 2;
const LABEL_FONT_PX = 10;
const EDGE_PX = 6;

/** Whether the browser remembers the grid view as on. */
export function readStoredGridView(storage) {
  try {
    return storage?.getItem?.(GRID_VIEW_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Remember the grid view in this browser. */
export function persistGridView(storage, enabled) {
  try {
    storage?.setItem?.(GRID_VIEW_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
}

/**
 * Give an orthographic frustum the `fov`/`fovy` readers the flights,
 * military, CCTV, launches and celestial-ring pixel math expect from a
 * perspective one: the vertical angle a perspective camera would need at
 * the camera's current height to show the same ground. Writes are ignored
 * (an orthographic frustum has no angle to set).
 * @param {import('cesium').OrthographicFrustum} frustum
 * @param {() => number} distance Camera distance to the ground, metres.
 */
export function installOrthographicFovCompatibility(frustum, distance) {
  Object.defineProperties(frustum, {
    fovy: {
      configurable: true,
      enumerable: false,
      get() {
        return (
          orthographicFovy(this.width, this.aspectRatio, distance()) ??
          DEFAULT_FOVY
        );
      },
      set() {},
    },
    fov: {
      configurable: true,
      enumerable: false,
      get() {
        return orthographicFov(this.fovy, this.aspectRatio || 1);
      },
      set() {},
    },
  });
  return frustum;
}

/**
 * Read the grid's colours from the page's theme tokens; the fallbacks only
 * answer outside a document (unit tests).
 */
export function readGridTheme(documentRef = globalThis.document) {
  const root = documentRef?.documentElement;
  const view = documentRef?.defaultView;
  const style =
    root && typeof view?.getComputedStyle === 'function'
      ? view.getComputedStyle(root)
      : null;
  const token = (name, fallback) => {
    const value = style?.getPropertyValue?.(name);
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
  };
  return {
    line: token('--event-grid-line', token('--accent', '#00ff41')),
    label: token('--event-grid-label', token('--text-primary', '#e8eaed')),
    backdrop: token('--event-grid-backdrop', token('--bg-dark', '#020a04')),
    font: token('--font-mono', 'monospace'),
  };
}

/**
 * The top-down grid view: an orthographic frustum on the 3D camera (never
 * `SceneMode.SCENE2D`), aimed straight down and north up, with tilt and look
 * locked, a darker base map, and a canvas of graticule lines with degree and
 * MGRS labels. The canvas redraws when the camera stops, when the window
 * resizes and, while a gesture or flight moves the camera, once per rendered
 * frame; an idle view costs nothing.
 *
 * @param {object} options
 * @param {import('cesium').Viewer} options.viewer
 * @param {{getImageryHostTileset?: Function, subscribe?: Function}} [options.mapStackController]
 * @param {Document} [options.documentRef]
 * @param {(reason: string) => void} [options.requestRender]
 * @param {Storage|null} [options.storage] Where the preference is kept.
 */
export function createGridView({
  viewer,
  mapStackController = null,
  documentRef = globalThis.document,
  requestRender = () => {},
  storage = null,
}) {
  const scene = viewer?.scene;
  const camera = scene?.camera;
  if (!scene || !camera) throw new TypeError('Grid view needs a viewer');

  let enabled = false;
  let destroyed = false;
  let canvas = null;
  let context = null;
  let theme = null;
  let savedFrustum = null;
  let savedControls = null;
  /** @type {{tileset?: object, style?: object, layer?: object, brightness?: number}|null} */
  let darkened = null;
  let moving = false;
  /** Listeners that live only while the view is on. */
  let removers = [];
  let removeFrameHook = null;

  const removeMoveStart = camera.moveStart.addEventListener(() => {
    moving = true;
    if (enabled) startFollowing();
  });
  const removeMoveEnd = camera.moveEnd.addEventListener(() => {
    moving = false;
    stopFollowing();
    if (!enabled) return;
    // A flight or gesture ended: a locked view is always north up and
    // straight down, so correct the orientation it left behind.
    ensureStraightDown();
    draw();
  });

  const window = () => documentRef?.defaultView ?? null;

  function groundDistance() {
    const height = camera.positionCartographic?.height;
    return Number.isFinite(height) ? Math.max(1, height) : 1;
  }

  /** Whether the orbit frame already reads as north up and straight down. */
  function isStraightDown(frame) {
    if (!frame) return false;
    const heading = Cesium.Math.negativePiToPi(frame.heading || 0);
    return (
      frame.pitch <= STRAIGHT_DOWN + PITCH_TOLERANCE &&
      Math.abs(heading) <= HEADING_TOLERANCE
    );
  }

  /** Aim straight down at the viewport centre, north up. */
  function aimStraightDown() {
    const frame = readCameraTargetFrame(viewer);
    if (
      frame &&
      setCameraTargetFrame(viewer, {
        ...frame,
        heading: 0,
        pitch: STRAIGHT_DOWN,
      })
    )
      return true;
    try {
      camera.setView({
        destination: Cesium.Cartesian3.clone(camera.positionWC),
        orientation: { heading: 0, pitch: STRAIGHT_DOWN, roll: 0 },
      });
      return true;
    } catch {
      return false;
    }
  }

  function ensureStraightDown() {
    if (isStraightDown(readCameraTargetFrame(viewer))) return false;
    return aimStraightDown();
  }

  function enterOrthographic() {
    if (camera.frustum instanceof Cesium.OrthographicFrustum) return;
    savedFrustum = camera.frustum;
    camera.switchToOrthographicFrustum();
    installOrthographicFovCompatibility(camera.frustum, groundDistance);
  }

  function leaveOrthographic() {
    if (!(camera.frustum instanceof Cesium.OrthographicFrustum)) return;
    if (savedFrustum && !(savedFrustum instanceof Cesium.OrthographicFrustum)) {
      const aspect = scene.drawingBufferWidth / scene.drawingBufferHeight;
      if (Number.isFinite(aspect) && aspect > 0)
        savedFrustum.aspectRatio = aspect;
      camera.frustum = savedFrustum;
    } else {
      camera.switchToPerspectiveFrustum();
    }
    savedFrustum = null;
  }

  function lockCamera() {
    const controller = scene.screenSpaceCameraController;
    if (!controller || savedControls) return;
    savedControls = {
      enableTilt: controller.enableTilt,
      enableLook: controller.enableLook,
    };
    controller.enableTilt = false;
    controller.enableLook = false;
  }

  function unlockCamera() {
    const controller = scene.screenSpaceCameraController;
    if (controller && savedControls) {
      controller.enableTilt = savedControls.enableTilt;
      controller.enableLook = savedControls.enableLook;
    }
    savedControls = null;
  }

  function shownTileset() {
    const host = mapStackController?.getImageryHostTileset?.();
    if (host && !host.isDestroyed?.()) return host;
    const primitives = scene.primitives;
    const count = primitives?.length ?? 0;
    for (let index = 0; index < count; index += 1) {
      const primitive = primitives.get(index);
      if (primitive instanceof Cesium.Cesium3DTileset && primitive.show)
        return primitive;
    }
    return null;
  }

  /** Darken whatever base is showing: the tileset's tint or the imagery. */
  function darkenBase() {
    restoreBase();
    const tileset = shownTileset();
    if (tileset) {
      const grey = Math.round(GRID_VIEW_BASE_LUMINANCE * 255)
        .toString(16)
        .padStart(2, '0');
      darkened = { tileset, style: tileset.style };
      tileset.style = new Cesium.Cesium3DTileStyle({
        color: `color('#${grey}${grey}${grey}')`,
      });
      return;
    }
    const layers = viewer.imageryLayers;
    const base = scene.globe?.show && layers?.length ? layers.get(0) : null;
    if (base) {
      darkened = { layer: base, brightness: base.brightness };
      base.brightness = GRID_VIEW_BASE_LUMINANCE;
    }
  }

  function restoreBase() {
    if (!darkened) return;
    const { tileset, style, layer, brightness } = darkened;
    darkened = null;
    try {
      if (tileset && !tileset.isDestroyed?.()) tileset.style = style;
      if (layer && !layer.isDestroyed?.()) layer.brightness = brightness;
    } catch {
      /* the base may already be gone */
    }
  }

  function ensureCanvas() {
    if (canvas) return canvas;
    canvas = documentRef.createElement('canvas');
    canvas.id = GRID_VIEW_OVERLAY_ID;
    canvas.setAttribute('aria-hidden', 'true');
    (viewer.container || documentRef.body).appendChild(canvas);
    context = canvas.getContext('2d');
    return canvas;
  }

  /** Canvas-space position of a ground point, or null when off screen. */
  function project(lon, lat) {
    const position = Cesium.Cartesian3.fromDegrees(lon, lat);
    let point = null;
    try {
      point = scene.cartesianToCanvasCoordinates(position);
    } catch {
      return null;
    }
    return point && Number.isFinite(point.x) && Number.isFinite(point.y)
      ? { x: point.x, y: point.y }
      : null;
  }

  /** Degrees under a canvas point, or null for sky. */
  function groundAt(x, y) {
    let cartesian = null;
    try {
      cartesian = camera.pickEllipsoid(
        new Cesium.Cartesian2(x, y),
        scene.globe?.ellipsoid ?? Cesium.Ellipsoid.WGS84,
      );
    } catch {
      return null;
    }
    if (!cartesian) return null;
    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    return carto
      ? {
          lat: Cesium.Math.toDegrees(carto.latitude),
          lon: Cesium.Math.toDegrees(carto.longitude),
        }
      : null;
  }

  /** The ground extent on screen, from a 3×3 sample of the canvas. */
  function visibleExtent(width, height) {
    const samples = [];
    for (const fx of [0, 0.5, 1]) {
      for (const fy of [0, 0.5, 1]) {
        samples.push(groundAt(fx * width, fy * height));
      }
    }
    const sampled = extentOfSamples(samples, { minimum: 5 });
    if (sampled) return sampled;
    let rectangle = null;
    try {
      rectangle = camera.computeViewRectangle(
        scene.globe?.ellipsoid ?? Cesium.Ellipsoid.WGS84,
      );
    } catch {
      rectangle = null;
    }
    if (!rectangle) return null;
    return {
      west: Cesium.Math.toDegrees(rectangle.west),
      south: Cesium.Math.toDegrees(rectangle.south),
      east: Cesium.Math.toDegrees(rectangle.east),
      north: Cesium.Math.toDegrees(rectangle.north),
    };
  }

  function strokeSamples(points) {
    let open = false;
    context.beginPath();
    for (const point of points) {
      if (!point) {
        open = false;
        continue;
      }
      if (open) context.lineTo(point.x, point.y);
      else context.moveTo(point.x, point.y);
      open = true;
    }
    context.stroke();
  }

  function sampleLine(from, to) {
    const points = [];
    for (let index = 0; index <= LINE_SAMPLES; index += 1) {
      const t = index / LINE_SAMPLES;
      points.push(
        project(
          from.lon + (to.lon - from.lon) * t,
          from.lat + (to.lat - from.lat) * t,
        ),
      );
    }
    return points;
  }

  function label(text, x, y, { align = 'left', baseline = 'top' } = {}) {
    if (!text) return;
    context.font = `${LABEL_FONT_PX}px ${theme.font}`;
    context.textAlign = align;
    context.textBaseline = baseline;
    const metrics = context.measureText(text);
    const padX = 3;
    const width = metrics.width + padX * 2;
    const height = LABEL_FONT_PX + 4;
    const left =
      align === 'center' ? x - width / 2 : align === 'right' ? x - width : x;
    const top =
      baseline === 'middle'
        ? y - height / 2
        : baseline === 'bottom'
          ? y - height
          : y;
    context.globalAlpha = 0.72;
    context.fillStyle = theme.backdrop;
    context.fillRect(left, top, width, height);
    context.globalAlpha = 1;
    context.fillStyle = theme.label;
    const textX =
      align === 'center' ? x : align === 'right' ? x - padX : x + padX;
    const textY =
      baseline === 'middle' ? y : baseline === 'bottom' ? y - 2 : y + 2;
    context.fillText(text, textX, textY);
  }

  /** Paint the graticule and its labels for the current camera. */
  function draw() {
    if (!enabled || !canvas || !context || destroyed) return;
    const sceneCanvas = scene.canvas;
    const width = sceneCanvas?.clientWidth || 0;
    const height = sceneCanvas?.clientHeight || 0;
    if (!width || !height) return;
    const ratio = Math.min(MAX_PIXEL_RATIO, window()?.devicePixelRatio || 1);
    const bufferWidth = Math.round(width * ratio);
    const bufferHeight = Math.round(height * ratio);
    if (canvas.width !== bufferWidth || canvas.height !== bufferHeight) {
      canvas.width = bufferWidth;
      canvas.height = bufferHeight;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    const rect = visibleExtent(width, height);
    if (!rect) return;
    const spacing = chooseGridSpacing(gridSpanDeg(rect));
    if (!spacing) return;
    const extent = normalizeExtent(rect);
    const { parallels, meridians } = gridLines(rect, spacing);

    context.lineWidth = 1;
    context.strokeStyle = theme.line;
    context.globalAlpha = 0.55;
    for (const lat of parallels) {
      strokeSamples(
        sampleLine({ lon: extent.west, lat }, { lon: extent.east, lat }),
      );
    }
    for (const lon of meridians) {
      strokeSamples(
        sampleLine({ lon, lat: extent.south }, { lon, lat: extent.north }),
      );
    }
    context.globalAlpha = 1;

    for (const lon of meridians) {
      const top = project(lon, extent.north) || project(lon, extent.south);
      if (top && top.x > EDGE_PX && top.x < width - EDGE_PX)
        label(formatGridDegrees(lon, 'lon', spacing), top.x + 2, EDGE_PX);
    }
    for (const lat of parallels) {
      const left = project(extent.west, lat) || project(extent.east, lat);
      if (left && left.y > EDGE_PX * 3 && left.y < height - EDGE_PX)
        label(formatGridDegrees(lat, 'lat', spacing), EDGE_PX, left.y - 2, {
          baseline: 'bottom',
        });
    }
    const precision = mgrsPrecisionForSpacing(spacing);
    for (const cell of gridCellCenters(rect, spacing)) {
      const point = project(cell.lon, cell.lat);
      if (!point) continue;
      label(mgrsAt(cell.lon, cell.lat, precision), point.x, point.y, {
        align: 'center',
        baseline: 'middle',
      });
    }
  }

  function startFollowing() {
    if (removeFrameHook || !scene.postRender?.addEventListener) return;
    removeFrameHook = scene.postRender.addEventListener(() => draw());
  }

  function stopFollowing() {
    removeFrameHook?.();
    removeFrameHook = null;
  }

  function installEnabledListeners() {
    const view = window();
    if (view?.addEventListener) {
      const onResize = () => draw();
      const onStyle = () => {
        // The style's custom properties settle after the class flip.
        setTimeout(() => {
          if (!enabled) return;
          theme = readGridTheme(documentRef);
          draw();
        }, 0);
      };
      view.addEventListener('resize', onResize);
      view.addEventListener('gev:style-change', onStyle);
      removers.push(() => view.removeEventListener('resize', onResize));
      removers.push(() =>
        view.removeEventListener('gev:style-change', onStyle),
      );
    }
    if (typeof mapStackController?.subscribe === 'function') {
      const unsubscribe = mapStackController.subscribe((state) => {
        if (enabled && state?.status === 'ready') {
          darkenBase();
          requestRender('grid-view-base');
        }
      });
      if (typeof unsubscribe === 'function') removers.push(unsubscribe);
    }
    if (moving) startFollowing();
  }

  function removeEnabledListeners() {
    stopFollowing();
    for (const remove of removers.splice(0)) {
      try {
        remove();
      } catch {
        /* already gone */
      }
    }
  }

  function enable() {
    enabled = true;
    ensureCanvas();
    theme = readGridTheme(documentRef);
    documentRef.body?.classList?.add(GRID_VIEW_BODY_CLASS);
    lockCamera();
    // Aim before switching: the orthographic width is taken from the depth
    // under the viewport centre as seen through the perspective frustum.
    // A camera in flight keeps flying; moveEnd straightens it on arrival.
    if (!moving) aimStraightDown();
    enterOrthographic();
    darkenBase();
    installEnabledListeners();
    draw();
    requestRender('grid-view');
  }

  function disable() {
    enabled = false;
    removeEnabledListeners();
    leaveOrthographic();
    unlockCamera();
    restoreBase();
    documentRef.body?.classList?.remove(GRID_VIEW_BODY_CLASS);
    if (canvas && context) {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
    }
    requestRender('grid-view');
  }

  return {
    /** Whether the grid view is on. */
    isEnabled: () => enabled,
    get enabled() {
      return enabled;
    },
    /**
     * Turn the grid view on or off.
     * @param {boolean} next
     * @param {{persist?: boolean}} [options] Remember the choice in this browser.
     * @returns {boolean} Whether the state changed.
     */
    setEnabled(next, { persist = true } = {}) {
      if (destroyed) return false;
      const target = Boolean(next);
      if (target === enabled) return false;
      if (target) enable();
      else disable();
      if (persist) persistGridView(storage, target);
      return true;
    },
    toggle(options) {
      return this.setEnabled(!enabled, options);
    },
    /** The remembered preference, without applying it. */
    readStored: () => readStoredGridView(storage),
    /** Repaint now (resize handlers, QA). */
    redraw: draw,
    /** The overlay canvas, once created. */
    get element() {
      return canvas;
    },
    /** QA seam: the orthographic frustum, lock and tint state. */
    _stateForTest() {
      return {
        enabled,
        orthographic: camera.frustum instanceof Cesium.OrthographicFrustum,
        tiltLocked: scene.screenSpaceCameraController?.enableTilt === false,
        darkened: darkened ? (darkened.tileset ? 'tileset' : 'imagery') : null,
        moving,
      };
    },
    destroy() {
      if (destroyed) return;
      if (enabled) disable();
      destroyed = true;
      removeMoveStart?.();
      removeMoveEnd?.();
      canvas?.remove();
      canvas = null;
      context = null;
    },
  };
}
