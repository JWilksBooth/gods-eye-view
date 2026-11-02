import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from 'cesium';
import { createState } from './state.js';
import { createStyle } from './style.js';
import { createModel } from './model.js';
import { createAnimation } from './animation.js';
import { createRendering } from './rendering.js';
import { createRetention } from './retention.js';
import { createControls } from './controls.js';
import { createTrafficLayer, createTrafficSource } from './index.js';
import { FLOW_LINE_CAP } from './policy.js';

/** A scene with ground primitives and a frame event, and no WebGL context. */
function fakeScene() {
  const listeners = new Set();
  const ground = [];
  return {
    frameState: { context: { depthTexture: true } },
    canvas: { clientWidth: 800, clientHeight: 600 },
    groundPrimitives: {
      list: ground,
      add(prim) {
        ground.push(prim);
        return prim;
      },
      remove(prim) {
        const index = ground.indexOf(prim);
        if (index >= 0) ground.splice(index, 1);
        return index >= 0;
      },
    },
    postRender: {
      addEventListener(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    frame() {
      for (const listener of [...listeners]) listener();
    },
    renders: 0,
    requestRender() {
      this.renders += 1;
    },
  };
}

// One road per bucket the dots know (free, slow, jam, closed) and one TomTom
// has no flow for.
const FLOWS = [
  { level: 1, closure: false },
  { level: 0.7, closure: false },
  { level: 0.2, closure: false },
  { level: 0, closure: true },
  null,
];

function setup(t, { liveMode = true, vehicles = 'off' } = {}) {
  // Exercise the real GroundPolylinePrimitive and Material branches without
  // a WebGL context or a DOM (material typing probes the image classes).
  const width = C.ContextLimits._maximumAliasedLineWidth;
  C.ContextLimits._maximumAliasedLineWidth = 1;
  for (const key of [
    'HTMLCanvasElement',
    'HTMLImageElement',
    'ImageBitmap',
    'OffscreenCanvas',
  ]) {
    const prior = globalThis[key];
    globalThis[key] = class {};
    t.after(() => {
      if (prior === undefined) delete globalThis[key];
      else globalThis[key] = prior;
    });
  }
  t.after(() => {
    C.ContextLimits._maximumAliasedLineWidth = width;
  });
  const holds = [];
  const reloads = [];
  const state = createState({ services: {} });
  state._enabled = true;
  state._liveMode = liveMode;
  state._vehicles = vehicles;
  state._pointCollection = new C.PointPrimitiveCollection();
  const scene = fakeScene();
  state._viewer = {
    scene,
    camera: { positionWC: C.Cartesian3.fromDegrees(0, 0, 500) },
  };
  const parts = {
    viewport: { onCameraChanged: (options) => reloads.push(options) },
  };
  const ctx = {
    state,
    services: {
      credits: {},
      render: {
        holdContinuousRender: (id) => holds.push(['hold', id]),
        releaseContinuousRender: (id) => holds.push(['release', id]),
      },
    },
    parts,
    source: { getFlowSessionStats: () => ({ tilesFetched: 0 }) },
  };
  parts.style = createStyle(ctx);
  parts.model = createModel(ctx);
  parts.animation = createAnimation(ctx);
  parts.retention = createRetention(ctx);
  parts.rendering = createRendering(ctx);
  parts.controls = createControls(ctx);
  parts.style.refreshBucketColors();
  t.after(() => {
    parts.animation.clearDots();
    state._pointCollection.destroy();
  });
  const roads = (flows = FLOWS) =>
    parts.model.parseRoads({
      roads: flows.map((flow, i) => ({
        type: i === 0 ? 'motorway' : 'primary',
        oneway: 1,
        flow,
        coordinates: [
          [i * 0.01, 0],
          [i * 0.01 + 0.003, 0],
          [i * 0.01 + 0.004, 0.001],
        ],
      })),
    });
  const rgb = (instance) => [...instance.attributes.color.value.slice(0, 3)];
  return { state, parts, scene, holds, reloads, roads, rgb };
}

test('vehicles off draws the flow on the roads, bucket by bucket, and spawns no dots', (t) => {
  const h = setup(t);
  const roads = h.roads();
  h.parts.rendering.renderRoadsForAltitude(roads, 450, 'Loaded full');
  assert.equal(h.state._dots.length, 0);
  assert.equal(h.state._pointCollection.length, 0);
  assert.ok(h.state._heatJamPrim instanceof C.GroundPolylinePrimitive);
  assert.equal(h.state._heatJamPrim.geometryInstances.length, 1);
  assert.equal(h.state._flowLinesPrim.geometryInstances.length, 3);
  assert.equal(h.state._flowClosedPrim.geometryInstances.length, 1);
  assert.equal(h.scene.groundPrimitives.list.length, 3);
  // Slow, free and simulated roads share one batch, coloured per instance
  // with the dots' bucket colours and the dots' white.
  assert.deepEqual(h.state._flowLinesPrim.geometryInstances.map(h.rgb), [
    [240, 178, 62],
    [46, 204, 113],
    [255, 255, 255],
  ]);
  assert.deepEqual(h.state._bucketCounts, { free: 1, slow: 1, jam: 1, sim: 1 });
  assert.equal(h.state._closedRoads, 1);
  assert.equal(h.state._count, 5);
  assert.equal(h.state._heatLineCount, 5);
  assert.ok(h.state._lastUpdate);
  assert.ok(h.scene.renders > 0);
  // The jam glow pulses, so the layer holds continuous rendering exactly as
  // the heat-line prototype does.
  assert.equal(h.state._renderHeld, true);
  const stats = h.parts.controls.methods.getStats();
  assert.equal(stats.count, 5);
  assert.equal(stats.vehicles, 'off');
  assert.equal(stats.flowCoveragePct, 75);
  assert.equal(stats.heatLines, 5);
  assert.equal(stats.mode, 'live');
  assert.match(stats.loadingLabel, /^LIVE/);
  assert.deepEqual(h.parts.controls.methods.getDetectableObjects(), []);
  // Lines drape onto terrain and 3D tiles alike while the globe shows.
  assert.equal(
    h.state._flowLinesPrim.classificationType,
    C.ClassificationType.BOTH,
  );
  // The strict uncovered view leaves roads without flow undrawn, as it
  // leaves them without dots.
  h.state._uncoveredMode = 'hide';
  h.parts.rendering.renderRoadsForAltitude(roads, 450, 'Loaded full');
  assert.equal(h.state._flowLinesPrim.geometryInstances.length, 2);
  assert.equal(h.state._bucketCounts.sim, 0);
  assert.equal(h.state._count, 4);
  // With the globe hidden under Google 3D, only the tiles carry the lines.
  h.scene.globe = { show: false };
  h.parts.rendering.renderRoadsForAltitude(roads, 450, 'Loaded full');
  assert.equal(
    h.state._flowLinesPrim.classificationType,
    C.ClassificationType.CESIUM_3D_TILE,
  );
});

test('a rebuild keeps the old batches on screen until the new ones have rendered', (t) => {
  const h = setup(t);
  const roads = h.roads();
  h.parts.rendering.renderRoadsForAltitude(roads, 450, 'Loaded full');
  const first = [...h.scene.groundPrimitives.list];
  const swaps = () => h.holds.filter(([, id]) => id === 'traffic-flow-swap');
  assert.deepEqual(swaps(), [['hold', 'traffic-flow-swap']]);
  for (const prim of first) prim._ready = true;
  h.scene.frame();
  assert.deepEqual(swaps().at(-1), ['release', 'traffic-flow-swap']);
  // Same roads, same flow: nothing to rebuild.
  h.parts.rendering.renderRoadsForAltitude(roads, 450, 'Cached zoom');
  assert.deepEqual(h.scene.groundPrimitives.list, first);
  // The free road jams late: the replacement is built beside the old batches,
  // rendering is held for the hand-over, and the old batches go once every
  // new one has rendered.
  roads[0].flow = { level: 0.1, closure: false };
  h.parts.model.recolorDotsInPlace('late flow');
  assert.equal(h.scene.groundPrimitives.list.length, 6);
  assert.deepEqual(swaps().at(-1), ['hold', 'traffic-flow-swap']);
  h.scene.frame();
  assert.equal(h.scene.groundPrimitives.list.length, 6);
  for (const prim of h.scene.groundPrimitives.list.slice(3)) prim._ready = true;
  h.scene.frame();
  assert.equal(h.scene.groundPrimitives.list.length, 3);
  assert.ok(
    first.every((prim) => !h.scene.groundPrimitives.list.includes(prim)),
  );
  assert.deepEqual(swaps().at(-1), ['release', 'traffic-flow-swap']);
  assert.equal(h.state._bucketCounts.jam, 2);
  assert.equal(h.state._bucketCounts.free, 0);
  assert.equal(h.state._heatJamPrim.geometryInstances.length, 2);
  assert.equal(h.state._flowLinesPrim.geometryInstances.length, 2);
  // Clearing takes every batch with it, waiting or not.
  h.parts.animation.clearDots();
  assert.equal(h.scene.groundPrimitives.list.length, 0);
  assert.equal(h.state._heatLineCount, 0);
  assert.equal(h.state._flowMapRoads, null);
  assert.deepEqual(h.state._roads, []);
});

test('keyless, every road draws in the simulation white and the layer says so', (t) => {
  const h = setup(t, { liveMode: false });
  h.parts.rendering.renderRoadsForAltitude(h.roads(), 450, 'Loaded full');
  assert.equal(h.state._heatJamPrim, null);
  assert.equal(h.state._flowClosedPrim, null);
  assert.equal(h.state._flowLinesPrim.geometryInstances.length, 5);
  assert.ok(
    h.state._flowLinesPrim.geometryInstances
      .map(h.rgb)
      .every((rgb) => rgb.every((channel) => channel === 255)),
  );
  assert.deepEqual(h.state._bucketCounts, { free: 0, slow: 0, jam: 0, sim: 5 });
  assert.equal(h.state._closedRoads, 0);
  // Static lines hold no continuous render.
  assert.equal(Boolean(h.state._renderHeld), false);
  const stats = h.parts.controls.methods.getStats();
  assert.equal(stats.mode, 'sim');
  assert.equal(stats.count, 5);
  assert.match(stats.loadingLabel, /^SIMULATED — add TomTom key for live/);
});

test('the cap keeps congestion first and the quiet edge of the view goes', (t) => {
  const h = setup(t);
  const flows = [
    ...Array.from({ length: FLOW_LINE_CAP }, () => ({
      level: 1,
      closure: false,
    })),
    ...Array.from({ length: 5 }, () => ({ level: 0.2, closure: false })),
  ];
  h.parts.rendering.renderRoadsForAltitude(h.roads(flows), 450, 'Loaded full');
  assert.equal(h.state._heatLineCount, FLOW_LINE_CAP);
  assert.equal(h.state._bucketCounts.jam, 5);
  assert.equal(h.state._bucketCounts.free, FLOW_LINE_CAP - 5);
});

test('the switch re-renders in place: off clears the dots for lines, on reloads the view for dots', (t) => {
  const h = setup(t, { vehicles: 'on' });
  const roads = h.roads();
  h.parts.rendering.renderRoadsForAltitude(roads, 450, 'Loaded full');
  assert.ok(h.state._dots.length > 0);
  assert.equal(h.state._flowLinesPrim, null);
  const controls = h.parts.controls.methods;
  assert.equal(controls.getParams().vehicles, 'on');
  controls.setParams({ vehicles: 'off' }, { origin: 'user' });
  assert.equal(controls.getParams().vehicles, 'off');
  assert.equal(h.state._dots.length, 0);
  assert.equal(h.state._pointCollection.length, 0);
  assert.equal(h.state._flowLinesPrim.geometryInstances.length, 3);
  assert.equal(h.state._heatJamPrim.geometryInstances.length, 1);
  assert.equal(h.state._flowClosedPrim.geometryInstances.length, 1);
  assert.deepEqual(h.reloads, []);
  controls.setParams({ vehicles: 'on' }, { origin: 'user' });
  assert.equal(h.state._flowLinesPrim, null);
  assert.equal(h.state._heatJamPrim, null);
  assert.equal(h.state._heatLineCount, 0);
  assert.equal(h.scene.groundPrimitives.list.length, 0);
  assert.equal(h.state._lastBounds, null);
  assert.deepEqual(h.reloads, [{ immediate: true }]);
  // Junk and repeats change nothing.
  controls.setParams({ vehicles: 'sideways' });
  controls.setParams({ vehicles: 'on' });
  assert.equal(controls.getParams().vehicles, 'on');
  assert.equal(h.reloads.length, 1);
});

test('the vehicles option is part of the layer contract: default on, a row chip, params and stats', () => {
  const source = createTrafficSource({
    fetchImpl: () => assert.fail('construction fetched data'),
  });
  const layer = createTrafficLayer({
    services: { credits: {}, render: {} },
    source,
  });
  assert.equal(layer.getParams().vehicles, 'on');
  assert.equal(layer.getStats().vehicles, 'on');
  const chip = () =>
    layer.getRowControls().chips.find((entry) => entry.id === 'vehicles');
  assert.equal(chip().label, 'Vehicles');
  assert.equal(chip().active, true);
  assert.deepEqual(chip().params, { vehicles: 'off' });
  assert.match(chip().title, /^Simulated vehicles animate the flow/);
  layer.setParams({ vehicles: 'off' }, { origin: 'local-restore' });
  assert.equal(layer.getParams().vehicles, 'off');
  assert.equal(layer.getStats().vehicles, 'off');
  assert.equal(chip().active, false);
  assert.deepEqual(chip().params, { vehicles: 'on' });
  assert.match(chip().title, /no simulated vehicles/);
  layer.setParams({ vehicles: 'sideways' });
  assert.equal(layer.getParams().vehicles, 'off');
});
