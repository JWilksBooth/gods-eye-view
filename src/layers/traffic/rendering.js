import * as Cesium from 'cesium';
import { roadIdentity } from './retention.js';
import { flowBucket } from '../../data/trafficFlowStyle.js';
import { trafficStyleProfile } from '../../data/trafficPresetStyle.js';
import {
  HEAT_LINE_CAP,
  HEAT_JAM_COLOR,
  HEAT_SLOW_COLOR,
  HEAT_LINE_JAM_WIDTH,
  HEAT_JAM_BASE_ALPHA,
  HEAT_LINE_SLOW_WIDTH,
  FLOW_LINE_CAP,
  FLOW_LINE_ALPHA,
  FLOW_JAM_WIDTH_BOOST,
  FLOW_SIM_COLOR,
  FLOW_CLOSED_COLOR,
  FLOW_CLOSED_DASH_PX,
  FLOW_SWAP_FRAME_LIMIT,
  SIZE_BY_TYPE,
  TRAFFIC_TIMING_ENABLED,
} from './policy.js';

/** Flow-map keep order under the cap: congestion first, quiet roads last. */
const FLOW_LINE_ORDER = { jam: 0, slow: 1, closed: 2, free: 3, sim: 4 };

export function createRendering({
  state: layerState,
  services,
  parts,
  source,
}) {
  /**
   * At high altitude only major roads render — shared by the render pass and
   * the late-flow heat-line rebuild so lines never mark roads without dots.
   * @param {Array} roads    - Parsed road objects.
   * @param {number} altitude - Camera altitude in meters.
   * @returns {Array} The roads visible at this altitude.
   */

  function visibleRoadsForAltitude(roads, altitude) {
    return altitude > 5000
      ? roads.filter(
          (r) =>
            r.type === 'motorway' || r.type === 'trunk' || r.type === 'primary',
        )
      : roads;
  }

  /** Remove every road-line ground primitive (heat-lines and flow map) from the scene. */

  function removeHeatLines() {
    finishRetiring();
    let removed = false;
    for (const key of [
      '_heatJamPrim',
      '_heatSlowPrim',
      '_flowLinesPrim',
      '_flowClosedPrim',
    ]) {
      if (!layerState[key]) continue;
      layerState._viewer?.scene.groundPrimitives.remove(layerState[key]);
      layerState[key] = null;
      removed = true;
    }
    layerState._heatLineCount = 0;
    layerState._flowMapSignature = null;
    parts.animation.syncRenderDemand?.();
    // Static batches hold no render of their own; show their absence.
    if (removed) layerState._viewer?.scene?.requestRender?.();
  }

  /** @returns {boolean} Draped ground lines can be drawn in this scene (checked once). */

  function groundLinesSupported() {
    if (!layerState._viewer) return false;
    if (layerState._heatSupported === null) {
      layerState._heatSupported = Cesium.GroundPolylinePrimitive.isSupported(
        layerState._viewer.scene,
      );
      if (!layerState._heatSupported)
        console.warn(
          '[Data:Traffic] GroundPolylinePrimitive unsupported — road lines disabled',
        );
    }
    return layerState._heatSupported;
  }

  /**
   * Road lines drape onto whatever surface is rendered: terrain and 3D tiles
   * alike while the globe shows, 3D tiles alone when the globe is hidden
   * under Google 3D (the same rule the installations layer follows).
   * @returns {Cesium.ClassificationType}
   */

  function lineClassification() {
    return layerState._viewer?.scene?.globe?.show === false
      ? Cesium.ClassificationType.CESIUM_3D_TILE
      : Cesium.ClassificationType.BOTH;
  }

  /** Retire the batches a previous rebuild left waiting for their replacement. */

  function finishRetiring() {
    const retiring = layerState._flowRetiring;
    if (!retiring) return;
    layerState._flowRetiring = null;
    retiring.finish();
  }

  /**
   * Keep the previous flow batches on screen until every replacement has
   * rendered, so a rebuild (late flow, a completed pass, a style change)
   * never blinks the map off and on. Rendering is held for the hand-over:
   * an idle scene would otherwise never give the new batches the frames
   * they need to become ready. Without a render loop to wait on, the old
   * batches go at once.
   *
   * @param {Cesium.GroundPolylinePrimitive[]} previous - Batches to retire.
   * @param {Cesium.GroundPolylinePrimitive[]} added - Their replacements.
   */

  function retireAfter(previous, added) {
    finishRetiring();
    const scene = layerState._viewer?.scene;
    const drop = () => {
      for (const prim of previous) scene?.groundPrimitives.remove(prim);
    };
    if (!added.length || !scene?.postRender?.addEventListener) return drop();
    let frames = 0;
    let stop = null;
    const finish = () => {
      stop?.();
      stop = null;
      services.render?.releaseContinuousRender?.('traffic-flow-swap');
      drop();
    };
    stop = scene.postRender.addEventListener(() => {
      frames += 1;
      if (frames < FLOW_SWAP_FRAME_LIMIT && !added.every((prim) => prim.ready))
        return;
      if (layerState._flowRetiring?.finish === finish)
        layerState._flowRetiring = null;
      finish();
    });
    layerState._flowRetiring = { finish };
    services.render?.holdContinuousRender?.('traffic-flow-swap');
  }

  /**
   * The flow-map bucket of one road, or null to leave it undrawn: closures
   * and the dots' three speed buckets in live mode; 'sim' for a road without
   * flow (simulated speeds) unless the strict uncovered view hides it, and
   * for every road in keyless mode, where the whole layer is simulation.
   * @param {object} road - Parsed road.
   * @returns {'free'|'slow'|'jam'|'closed'|'sim'|null}
   */

  function flowLineBucket(road) {
    const flow = layerState._liveMode ? road.flow : null;
    if (flow?.closure) return 'closed';
    if (flow) return flowBucket(flow.level);
    if (layerState._liveMode && layerState._uncoveredMode === 'hide')
      return null;
    return 'sim';
  }

  /**
   * Flow-map colours: the dots' effective bucket colours (preset-aware), the
   * dots' white for simulated roads, dark red for closures. Mono presets
   * (NVG/FLIR/noir) discard hue, so congestion re-encodes as luminance:
   * jam white, slow light, free dim, simulated dimmer, closed near black.
   * @returns {{free: Cesium.Color, slow: Cesium.Color, jam: Cesium.Color, sim: Cesium.Color, closed: Cesium.Color}}
   */

  function flowLineColors() {
    const mono =
      layerState._presetDots === 'on' &&
      trafficStyleProfile(layerState._stylePreset) === 'mono';
    if (mono)
      return {
        jam: Cesium.Color.WHITE,
        slow: new Cesium.Color(0.75, 0.75, 0.75, FLOW_LINE_ALPHA),
        free: new Cesium.Color(0.45, 0.45, 0.45, FLOW_LINE_ALPHA),
        sim: new Cesium.Color(0.3, 0.3, 0.3, FLOW_SIM_COLOR.alpha),
        closed: new Cesium.Color(0.1, 0.1, 0.1, FLOW_CLOSED_COLOR.alpha),
      };
    const active = layerState._activeBucketColors;
    return {
      jam: active.jam,
      slow: active.slow.withAlpha(FLOW_LINE_ALPHA),
      free: active.free.withAlpha(FLOW_LINE_ALPHA),
      sim: FLOW_SIM_COLOR,
      closed: FLOW_CLOSED_COLOR,
    };
  }

  /**
   * Vehicles off: draw the flow on the roads themselves. Every drawn road
   * is a draped ground line in its bucket colour; jam roads reuse the
   * heat-line glow batch (`_heatJamPrim`) and its pulse, free, slow and
   * simulated roads share one per-instance-coloured batch, and closed roads
   * a dashed one. Capped at FLOW_LINE_CAP, congestion first. Roads and flow
   * unchanged since the last build leave the batches alone; otherwise the
   * old batches stay until the new ones have rendered (`retireAfter`).
   *
   * Also records what is drawn — bucket counts, closures and the layer count
   * — since no dot population does it in this mode.
   *
   * @param {Array} roads - Road objects visible in the current render.
   */

  function rebuildFlowLines(roads) {
    const candidates = [];
    for (const road of roads) {
      const bucket = flowLineBucket(road);
      if (!bucket) continue;
      road.key ||= roadIdentity(road);
      let len = 0;
      for (const d of road.segmentDist) len += d;
      candidates.push({ road, bucket, len });
    }
    candidates.sort((a, b) =>
      a.bucket === b.bucket
        ? b.len - a.len
        : FLOW_LINE_ORDER[a.bucket] - FLOW_LINE_ORDER[b.bucket],
    );
    const kept =
      candidates.length > FLOW_LINE_CAP
        ? candidates.slice(0, FLOW_LINE_CAP)
        : candidates;
    const counts = { free: 0, slow: 0, jam: 0, sim: 0 };
    let closed = 0;
    for (const c of kept) {
      if (c.bucket === 'closed') closed += 1;
      else counts[c.bucket] += 1;
    }
    const classificationType = lineClassification();
    const signature =
      `${layerState._presetDots}|${layerState._stylePreset}|${classificationType}|` +
      kept.map((c) => `${c.road.key}:${c.bucket}`).join(';');
    if (signature === layerState._flowMapSignature) {
      parts.animation.syncRenderDemand?.();
      return;
    }

    const previous = [
      layerState._heatJamPrim,
      layerState._heatSlowPrim,
      layerState._flowLinesPrim,
      layerState._flowClosedPrim,
    ].filter(Boolean);
    layerState._heatJamPrim = null;
    layerState._heatSlowPrim = null;
    layerState._flowLinesPrim = null;
    layerState._flowClosedPrim = null;
    const added = [];
    if (groundLinesSupported() && kept.length) {
      const scene = layerState._viewer.scene;
      const colors = flowLineColors();
      const jamInstances = [];
      const flowInstances = [];
      const closedInstances = [];
      for (const c of kept) {
        const geometry = new Cesium.GroundPolylineGeometry({
          positions: c.road.waypoints,
          width:
            (SIZE_BY_TYPE[c.road.type] || 4) +
            (c.bucket === 'jam' ? FLOW_JAM_WIDTH_BOOST : 0),
        });
        if (c.bucket === 'jam')
          jamInstances.push(new Cesium.GeometryInstance({ geometry }));
        else if (c.bucket === 'closed')
          closedInstances.push(new Cesium.GeometryInstance({ geometry }));
        else
          flowInstances.push(
            new Cesium.GeometryInstance({
              geometry,
              attributes: {
                color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                  colors[c.bucket],
                ),
              },
            }),
          );
      }
      const batch = (geometryInstances, appearance) => {
        const prim = scene.groundPrimitives.add(
          new Cesium.GroundPolylinePrimitive({
            geometryInstances,
            classificationType,
            allowPicking: false,
            appearance,
          }),
        );
        added.push(prim);
        return prim;
      };
      if (jamInstances.length)
        layerState._heatJamPrim = batch(
          jamInstances,
          new Cesium.PolylineMaterialAppearance({
            material: Cesium.Material.fromType('PolylineGlow', {
              color: colors.jam.withAlpha(HEAT_JAM_BASE_ALPHA),
              glowPower: 0.25,
            }),
          }),
        );
      if (flowInstances.length)
        layerState._flowLinesPrim = batch(
          flowInstances,
          new Cesium.PolylineColorAppearance(),
        );
      if (closedInstances.length)
        layerState._flowClosedPrim = batch(
          closedInstances,
          new Cesium.PolylineMaterialAppearance({
            material: Cesium.Material.fromType('PolylineDash', {
              color: colors.closed,
              gapColor: Cesium.Color.TRANSPARENT,
              dashLength: FLOW_CLOSED_DASH_PX,
            }),
          }),
        );
    }
    retireAfter(previous, added);
    layerState._flowMapSignature = signature;
    layerState._heatLineCount = added.length ? kept.length : 0;
    layerState._bucketCounts = counts;
    layerState._closedRoads = closed;
    layerState._count = layerState._heatLineCount;
    parts.animation.syncRenderDemand?.();
    layerState._viewer?.scene?.requestRender?.();
    if (candidates.length > kept.length) {
      console.log(
        `[Data:Traffic] Flow lines capped at ${FLOW_LINE_CAP} (${candidates.length} roads in view)`,
      );
    }
  }

  /**
   * Rebuild the congestion heat-line underlay (jam-viz heatline prototype):
   * slow/jam roads drape a corridor line onto the rendered 3D tiles — glowing
   * pulsing red for jam, faint flat amber for slow — with the dots animating
   * on top. Two batched GroundPolylinePrimitives (one per bucket) so the jam
   * batch pulses through one shared material. Capped at HEAT_LINE_CAP (jam
   * first, longest first); overflow is logged. No-op in sim mode, when the
   * heatline mode is off, or without ground-primitive support.
   *
   * @param {Array} roads - Road objects visible in the current render.
   */

  function rebuildHeatLines(roads) {
    // Vehicles off: the roads carry the flow themselves, every bucket.
    if (layerState._vehicles === 'off') return rebuildFlowLines(roads);
    removeHeatLines();
    if (
      !layerState._viewer ||
      !layerState._liveMode ||
      !parts.style.heatlineOn()
    )
      return;
    if (!groundLinesSupported()) return;

    const candidates = [];
    for (const road of roads) {
      const flow = road.flow;
      if (!flow || flow.closure) continue;
      const bucket = flowBucket(flow.level);
      if (bucket === 'free') continue;
      let len = 0;
      for (const d of road.segmentDist) len += d;
      candidates.push({ road, bucket, len });
    }
    candidates.sort((a, b) =>
      a.bucket === b.bucket ? b.len - a.len : a.bucket === 'jam' ? -1 : 1,
    );
    const kept = candidates.slice(0, HEAT_LINE_CAP);

    const instancesFor = (bucket, width) =>
      kept
        .filter((c) => c.bucket === bucket)
        .map(
          (c) =>
            new Cesium.GeometryInstance({
              geometry: new Cesium.GroundPolylineGeometry({
                positions: c.road.waypoints,
                width,
              }),
            }),
        );

    // Mono presets (NVG/FLIR/noir) discard hue — heat-lines re-encode in
    // luminance like the dots: jam = white glow, slow = faint gray.
    const monoHeat =
      layerState._presetDots === 'on' &&
      trafficStyleProfile(layerState._stylePreset) === 'mono';
    const jamLineColor = monoHeat ? Cesium.Color.WHITE : HEAT_JAM_COLOR;
    const slowLineColor = monoHeat
      ? new Cesium.Color(0.7, 0.7, 0.7, HEAT_SLOW_COLOR.alpha)
      : HEAT_SLOW_COLOR;

    const classificationType = lineClassification();
    const jamInstances = instancesFor('jam', HEAT_LINE_JAM_WIDTH);
    if (jamInstances.length) {
      layerState._heatJamPrim = layerState._viewer.scene.groundPrimitives.add(
        new Cesium.GroundPolylinePrimitive({
          geometryInstances: jamInstances,
          classificationType,
          appearance: new Cesium.PolylineMaterialAppearance({
            material: Cesium.Material.fromType('PolylineGlow', {
              color: jamLineColor.withAlpha(HEAT_JAM_BASE_ALPHA),
              glowPower: 0.25,
            }),
          }),
        }),
      );
    }
    const slowInstances = instancesFor('slow', HEAT_LINE_SLOW_WIDTH);
    if (slowInstances.length) {
      layerState._heatSlowPrim = layerState._viewer.scene.groundPrimitives.add(
        new Cesium.GroundPolylinePrimitive({
          geometryInstances: slowInstances,
          classificationType,
          appearance: new Cesium.PolylineMaterialAppearance({
            material: Cesium.Material.fromType('Color', {
              color: slowLineColor,
            }),
          }),
        }),
      );
    }

    layerState._heatLineCount = kept.length;
    parts.animation.syncRenderDemand?.();
    if (candidates.length > kept.length) {
      console.log(
        `[Data:Traffic] Heat-lines capped at ${HEAT_LINE_CAP} (${candidates.length} congested roads in view)`,
      );
    }
  }

  /**
   * Reconcile road populations without respawning retained dots.
   *
   * When zoomed out (>5 km), only major road types are rendered to reduce clutter.
   * Dot budgets are allocated fairly across visible roads via `allocateRoadDotBudgets`.
   *
   * @param {Array} roads    - Parsed road objects to render.
   * @param {number} altitude - Camera altitude in meters.
   * @param {string} label    - Logging label (e.g. "Cache full", "Loaded major").
   * @param {Object|null} [trace=null] - Development-only correlated load trace.
   */

  function renderRoadsForAltitude(
    roads,
    altitude,
    label,
    trace = null,
    replace = true,
  ) {
    const state =
      TRAFFIC_TIMING_ENABLED && trace
        ? parts.timing.trafficTimingRenderState(trace, label)
        : null;
    const renderId = state ? ++trace.renderSequence : null;

    layerState._lastPaintStage = label;
    layerState._lastRenderAltitude = altitude;

    // At high altitude, drop minor roads to reduce visual noise
    const filteredRoads = visibleRoadsForAltitude(roads, altitude);

    // Closed roads spawn zero dots (computeDotCount/spawnDotsForRoad) — count
    // them here so the closure signal is visible in stats even at zero dots.
    layerState._closedRoads = layerState._liveMode
      ? filteredRoads.reduce((n, r) => n + (r.flow?.closure ? 1 : 0), 0)
      : 0;

    // Fade distances must track the camera-to-AREA distance, not assume a
    // nadir view: oblique pitches put the loaded roads many km away even at
    // low altitude. Probe three roads and stretch the curves accordingly.
    let areaDist = altitude;
    if (layerState._viewer && filteredRoads.length) {
      const probes = [
        filteredRoads[0],
        filteredRoads[Math.floor(filteredRoads.length / 2)],
        filteredRoads[filteredRoads.length - 1],
      ];
      for (const probe of probes) {
        const wp = probe?.waypoints?.[0];
        if (wp)
          areaDist = Math.max(
            areaDist,
            Cesium.Cartesian3.distance(
              layerState._viewer.camera.positionWC,
              wp,
            ),
          );
      }
    }
    layerState._fadeScaleFar = Math.max(8000, areaDist * 1.5);
    layerState._fadeTransFar = Math.max(10000, areaDist * 1.8);

    if (layerState._vehicles === 'off') {
      renderFlowMap(roads, filteredRoads, altitude, label, replace);
      return;
    }

    const dotStart = state
      ? parts.timing.trafficTimingMark(state, 'dot-construction-start', {
          renderId,
          renderLabel: label,
          roadCount: roads.length,
          visibleRoadCount: filteredRoads.length,
        })
      : null;
    parts.retention.reconcile(filteredRoads, altitude, replace);
    if (layerState._dots.length && filteredRoads.some((r) => !r.directFlow))
      services.credits?.showOsmCredit?.(layerState._viewer, 'traffic', {
        openMapTiles: true,
      });
    else services.credits?.hideOsmCredit?.(layerState._viewer, 'traffic');
    parts.model.recolorDotsInPlace(label);

    const renderMetrics = state
      ? {
          renderId,
          renderLabel: label,
          roadCount: roads.length,
          visibleRoadCount: filteredRoads.length,
          dotCount: layerState._dots.length,
        }
      : null;
    if (state) {
      const dotEnd = parts.timing.trafficTimingMark(
        state,
        'dot-construction-end',
        renderMetrics,
      );
      parts.timing.trafficTimingMeasure(
        'dot-construction',
        state,
        dotStart,
        dotEnd,
        renderMetrics,
      );
    }

    const heatStart = state
      ? parts.timing.trafficTimingMark(
          state,
          'rebuild-heat-lines-start',
          renderMetrics,
        )
      : null;
    if (!label.includes('tile')) rebuildHeatLines(filteredRoads);
    if (state) {
      const heatEnd = parts.timing.trafficTimingMark(
        state,
        'rebuild-heat-lines-end',
        {
          ...renderMetrics,
          heatLineCount: layerState._heatLineCount,
        },
      );
      parts.timing.trafficTimingMeasure(
        'rebuild-heat-lines',
        state,
        heatStart,
        heatEnd,
        {
          ...renderMetrics,
          heatLineCount: layerState._heatLineCount,
        },
      );
    }

    parts.retention.refreshCounts();
    layerState._lastUpdate = Date.now();
    console.log(
      `[Data:Traffic] ${label}: ${layerState._count} dots (roads=${roads.length}, alt=${Math.round(altitude)}m)`,
    );
    if (state) {
      const renderEnd = parts.timing.trafficTimingMark(
        state,
        'render-return',
        renderMetrics,
      );
      parts.timing.scheduleTrafficTimingPostRender(
        state,
        renderEnd,
        renderId,
        renderMetrics,
      );
    }
  }
  /**
   * Vehicles off: no dot population. The roads of one load accumulate across
   * its paints (`replace` false) and reset on its completing paint, as the dot
   * retention does; draped lines need no measured heights, so each paint
   * draws straight from the roads it was given.
   *
   * @param {Array} roads - Parsed road objects passed to the render.
   * @param {Array} filteredRoads - The ones visible at this altitude.
   * @param {number} altitude - Camera altitude in meters.
   * @param {string} label - Logging label.
   * @param {boolean} replace - Whether this paint replaces the drawn set.
   */

  function renderFlowMap(roads, filteredRoads, altitude, label, replace) {
    const drawn =
      replace || !layerState._flowMapRoads
        ? new Map()
        : layerState._flowMapRoads;
    for (const road of filteredRoads)
      drawn.set((road.key ||= roadIdentity(road)), road);
    layerState._flowMapRoads = drawn;
    layerState._roads = [...drawn.values()];
    rebuildFlowLines(visibleRoadsForAltitude(layerState._roads, altitude));
    if (
      layerState._heatLineCount &&
      layerState._roads.some((road) => !road.directFlow)
    )
      services.credits?.showOsmCredit?.(layerState._viewer, 'traffic', {
        openMapTiles: true,
      });
    else services.credits?.hideOsmCredit?.(layerState._viewer, 'traffic');
    layerState._lastUpdate = Date.now();
    console.log(
      `[Data:Traffic] ${label}: ${layerState._heatLineCount} roads as flow lines (roads=${roads.length}, alt=${Math.round(altitude)}m)`,
    );
  }

  return {
    visibleRoadsForAltitude,
    removeHeatLines,
    rebuildHeatLines,
    rebuildFlowLines,
    renderRoadsForAltitude,
  };
}
