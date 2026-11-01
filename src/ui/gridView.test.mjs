import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  GRID_VIEW_BASE_LUMINANCE,
  GRID_VIEW_BODY_CLASS,
  GRID_VIEW_OVERLAY_ID,
  GRID_VIEW_STORAGE_KEY,
  createGridView,
  installOrthographicFovCompatibility,
  persistGridView,
  readGridTheme,
  readStoredGridView,
} from './gridView.js';

/** A listener list shaped like a Cesium Event. */
function cesiumEvent() {
  const listeners = new Set();
  return {
    addEventListener(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    raise() {
      for (const listener of [...listeners]) listener();
    },
    get size() {
      return listeners.size;
    },
  };
}

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    map,
  };
}

/** The slice of a document the controller touches. */
function fakeDocument() {
  const classes = new Set();
  const body = {
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
    children: [],
    appendChild(node) {
      this.children.push(node);
    },
  };
  const context = {
    calls: [],
    setTransform() {},
    clearRect() {
      this.calls.push('clear');
    },
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {
      this.calls.push('stroke');
    },
    measureText: (text) => ({ width: text.length * 6 }),
    fillRect() {},
    fillText(text) {
      this.calls.push(`text:${text}`);
    },
  };
  const documentRef = {
    body,
    documentElement: {},
    defaultView: {
      devicePixelRatio: 1,
      addEventListener() {},
      removeEventListener() {},
    },
    createElement(tag) {
      return {
        tag,
        attributes: {},
        width: 0,
        height: 0,
        setAttribute(name, value) {
          this.attributes[name] = value;
        },
        getContext: () => context,
        remove() {
          body.children = body.children.filter((child) => child !== this);
        },
      };
    },
  };
  return { documentRef, body, classes, context };
}

/**
 * A viewer with a real perspective frustum and the camera surface the
 * controller drives; picking answers a flat 1° square around the origin.
 */
function fakeViewer({
  tileset = null,
  globeShown = false,
  imagery = null,
} = {}) {
  const moveStart = cesiumEvent();
  const moveEnd = cesiumEvent();
  const postRender = cesiumEvent();
  const frustum = new Cesium.PerspectiveFrustum();
  frustum.fov = Cesium.Math.toRadians(60);
  frustum.aspectRatio = 16 / 9;
  const camera = {
    frustum,
    moveStart,
    moveEnd,
    positionWC: Cesium.Cartesian3.fromDegrees(0, 0, 5000),
    positionCartographic: new Cesium.Cartographic(0, 0, 5000),
    heading: 0,
    pitch: -Math.PI / 2,
    roll: 0,
    setViews: [],
    switchToOrthographicFrustum() {
      const ortho = new Cesium.OrthographicFrustum();
      ortho.aspectRatio = 16 / 9;
      ortho.width = 5000;
      this.frustum = ortho;
    },
    switchToPerspectiveFrustum() {
      this.frustum = new Cesium.PerspectiveFrustum();
    },
    setView(view) {
      this.setViews.push(view);
    },
    pickEllipsoid(windowPosition) {
      const lon = (windowPosition.x / 1600 - 0.5) * 1;
      const lat = (0.5 - windowPosition.y / 900) * 1;
      return Cesium.Cartesian3.fromDegrees(lon, lat);
    },
    computeViewRectangle() {
      return undefined;
    },
    getPickRay() {
      return undefined;
    },
  };
  const primitives = {
    items: tileset ? [tileset] : [],
    get length() {
      return this.items.length;
    },
    get(index) {
      return this.items[index];
    },
  };
  const scene = {
    camera,
    canvas: { clientWidth: 1600, clientHeight: 900, width: 1600, height: 900 },
    drawingBufferWidth: 1600,
    drawingBufferHeight: 900,
    postRender,
    primitives,
    globe: { show: globeShown, ellipsoid: Cesium.Ellipsoid.WGS84 },
    screenSpaceCameraController: { enableTilt: true, enableLook: true },
    pickPositionSupported: false,
    cartesianToCanvasCoordinates(position) {
      const carto = Cesium.Cartographic.fromCartesian(position);
      const lon = Cesium.Math.toDegrees(carto.longitude);
      const lat = Cesium.Math.toDegrees(carto.latitude);
      return new Cesium.Cartesian2((lon + 0.5) * 1600, (0.5 - lat) * 900);
    },
  };
  const layers = imagery ? [imagery] : [];
  const viewer = {
    scene,
    camera,
    container: {
      appendChild(node) {
        this.child = node;
      },
    },
    trackedEntity: undefined,
    imageryLayers: {
      get length() {
        return layers.length;
      },
      get: (i) => layers[i],
    },
  };
  return { viewer, camera, scene, moveStart, moveEnd, postRender };
}

test('the stored preference round-trips and tolerates missing storage', () => {
  const storage = memoryStorage();
  assert.equal(readStoredGridView(storage), false);
  persistGridView(storage, true);
  assert.equal(storage.getItem(GRID_VIEW_STORAGE_KEY), '1');
  assert.equal(readStoredGridView(storage), true);
  persistGridView(storage, false);
  assert.equal(readStoredGridView(storage), false);
  assert.equal(readStoredGridView(null), false);
  persistGridView(null, true);
  assert.equal(
    readStoredGridView({
      getItem() {
        throw new Error('blocked');
      },
    }),
    false,
  );
});

test('an orthographic frustum answers fov and fovy like the perspective camera it replaced', () => {
  const frustum = new Cesium.OrthographicFrustum();
  frustum.aspectRatio = 2;
  frustum.width = 2000;
  installOrthographicFovCompatibility(frustum, () => 1000);
  // Ground height 1000 m from 1000 m away: a 53.13° vertical angle.
  assert.ok(Math.abs(frustum.fovy - 2 * Math.atan(0.5)) < 1e-12);
  assert.ok(frustum.fov > frustum.fovy, 'the horizontal angle is wider at 2:1');
  frustum.fovy = 1;
  frustum.fov = 1;
  assert.ok(
    Math.abs(frustum.fovy - 2 * Math.atan(0.5)) < 1e-12,
    'writes are ignored',
  );
  assert.equal(
    Object.keys(frustum).includes('fovy'),
    false,
    'not enumerable, so clone() is unaffected',
  );
});

test('outside a document the theme falls back to a neutral palette', () => {
  const theme = readGridTheme(null);
  assert.ok(theme.line && theme.label && theme.backdrop && theme.font);
  const themed = readGridTheme({
    documentElement: {},
    defaultView: {
      getComputedStyle: () => ({
        getPropertyValue: (name) =>
          name === '--event-grid-line' ? ' #123456 ' : '',
      }),
    },
  });
  assert.equal(themed.line, '#123456');
});

test('turning the grid on aims straight down, goes orthographic, locks tilt, darkens the tileset and draws; off restores everything', () => {
  const tileset = { show: true, style: null, isDestroyed: () => false };
  Object.setPrototypeOf(tileset, Cesium.Cesium3DTileset.prototype);
  const { viewer, camera, scene, moveEnd } = fakeViewer({ tileset });
  const { documentRef, classes, context } = fakeDocument();
  const storage = memoryStorage();
  const renders = [];
  const perspective = camera.frustum;
  const grid = createGridView({
    viewer,
    documentRef,
    storage,
    requestRender: (reason) => renders.push(reason),
  });
  assert.equal(grid.isEnabled(), false);

  assert.equal(grid.setEnabled(true), true);
  assert.equal(grid.isEnabled(), true);
  assert.ok(
    camera.frustum instanceof Cesium.OrthographicFrustum,
    'orthographic on the 3D camera',
  );
  assert.ok(
    Number.isFinite(camera.frustum.fovy),
    'fovy compatibility installed',
  );
  assert.equal(scene.screenSpaceCameraController.enableTilt, false);
  assert.equal(scene.screenSpaceCameraController.enableLook, false);
  assert.ok(
    tileset.style instanceof Cesium.Cesium3DTileStyle,
    'the base is tinted',
  );
  assert.ok(classes.has(GRID_VIEW_BODY_CLASS));
  assert.equal(grid.element.id, GRID_VIEW_OVERLAY_ID);
  assert.equal(
    viewer.container.child,
    grid.element,
    'the canvas lives in the viewer container',
  );
  assert.ok(context.calls.includes('stroke'), 'grid lines were drawn');
  assert.ok(
    context.calls.some((call) => /^text:\d+(\.\d+)?°[NSEW]?$/.test(call)),
    'degree labels were drawn',
  );
  assert.ok(
    context.calls.some((call) => /^text:\d{1,2}[A-Z] [A-Z]{2} /.test(call)),
    'MGRS labels were drawn',
  );
  assert.equal(storage.getItem(GRID_VIEW_STORAGE_KEY), '1');
  assert.ok(renders.includes('grid-view'));
  const aimed = camera.setViews.at(-1);
  assert.ok(
    aimed,
    'with no pickable target frame the camera is aimed straight down in place',
  );
  assert.equal(aimed.orientation.heading, 0);
  assert.ok(Math.abs(aimed.orientation.pitch + Math.PI / 2) < 1e-12);
  assert.deepEqual(grid._stateForTest(), {
    enabled: true,
    orthographic: true,
    tiltLocked: true,
    darkened: 'tileset',
    moving: false,
  });

  assert.equal(grid.setEnabled(true), false, 'already on');
  const drawsBefore = context.calls.length;
  moveEnd.raise();
  assert.ok(context.calls.length > drawsBefore, 'a camera stop repaints');

  assert.equal(grid.setEnabled(false), true);
  assert.equal(
    camera.frustum,
    perspective,
    'the saved perspective frustum returns',
  );
  assert.ok(Math.abs(camera.frustum.aspectRatio - 16 / 9) < 1e-12);
  assert.equal(scene.screenSpaceCameraController.enableTilt, true);
  assert.equal(scene.screenSpaceCameraController.enableLook, true);
  assert.equal(tileset.style, null, 'the tint is restored');
  assert.equal(classes.has(GRID_VIEW_BODY_CLASS), false);
  assert.equal(storage.getItem(GRID_VIEW_STORAGE_KEY), '0');
  grid.destroy();
  assert.equal(grid.element, null);
  assert.equal(grid.setEnabled(true), false, 'destroyed controllers refuse');
});

test('a globe imagery base is dimmed through its brightness and a flight defers the aim to arrival', () => {
  const imagery = { brightness: 1, isDestroyed: () => false };
  const { viewer, camera, moveStart, moveEnd, postRender } = fakeViewer({
    globeShown: true,
    imagery,
  });
  const { documentRef, context } = fakeDocument();
  const grid = createGridView({ viewer, documentRef, storage: null });
  // The flight has carried the camera off nadir: 0.3° east of the target.
  camera.positionWC = Cesium.Cartesian3.fromDegrees(0.3, 0, 5000);
  moveStart.raise();
  grid.setEnabled(true, { persist: false });
  assert.equal(imagery.brightness, GRID_VIEW_BASE_LUMINANCE);
  assert.equal(
    camera.setViews.length,
    0,
    'a moving camera is left to its flight',
  );
  assert.equal(postRender.size, 1, 'frames repaint while the camera moves');
  const before = context.calls.length;
  postRender.raise();
  assert.ok(context.calls.length > before);
  moveEnd.raise();
  assert.equal(postRender.size, 0, 'and stop when it rests');
  assert.equal(camera.setViews.length, 1, 'arrival straightens the view');
  assert.equal(grid._stateForTest().darkened, 'imagery');
  grid.setEnabled(false, { persist: false });
  assert.equal(imagery.brightness, 1);
  grid.destroy();
});

test('a viewer without a scene is refused', () => {
  assert.throws(() => createGridView({ viewer: {} }), /needs a viewer/);
});
