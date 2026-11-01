import * as Cesium from 'cesium';
import { cameraPoseSignature, horizonOccluder } from '../../data/iconOrientation.js';
import { EVENT_ICON_ANCHORS } from './icons.js';
import { summarizeCluster } from './model.js';
import {
  CLUSTER_MIN_SIZE,
  CLUSTER_PIXEL_RANGE,
  CLUSTER_SIZE_PX,
  EVENT_CLUSTER_PICK_PREFIX,
  ICON_FAR_DISTANCE_M,
  ICON_FAR_SCALE,
  ICON_LIFT_M,
  ICON_NEAR_DISTANCE_M,
  ICON_SIZE_PX,
} from './policy.js';

/**
 * Billboards in a clustered CustomDataSource: one entity per event, constant
 * screen size, depth test off so icons read through terrain and buildings,
 * and Cesium's EntityCluster (the Radio layer's pattern) collapsing dense
 * areas into count badges. Entities change only inside `reconcile`, which
 * runs on data changes and camera stops; Cesium re-solves clusters on its
 * own camera-changed event, never from a per-frame hook here.
 */
export function createRendering({ state, services, parts }) {
  const { cachedGroundFloor } = services.ground;
  const { governorRequestRender } = services.render;
  const scaleByDistance = new Cesium.NearFarScalar(
    ICON_NEAR_DISTANCE_M,
    1,
    ICON_FAR_DISTANCE_M,
    ICON_FAR_SCALE,
  );

  /** World position of an event: its altitude, or the cached floor plus a lift. */
  function positionFor(event) {
    if (Number.isFinite(event.altitudeM)) {
      return Cesium.Cartesian3.fromDegrees(event.lon, event.lat, event.altitudeM);
    }
    const floor = cachedGroundFloor(event.lat, event.lon);
    return Cesium.Cartesian3.fromDegrees(
      event.lon,
      event.lat,
      (Number.isFinite(floor) ? floor : 0) + ICON_LIFT_M,
    );
  }

  function verticalOriginFor(kind) {
    return EVENT_ICON_ANCHORS[kind] === 'pin'
      ? Cesium.VerticalOrigin.BOTTOM
      : Cesium.VerticalOrigin.CENTER;
  }

  function ensureDataSource(viewer) {
    if (state._dataSource) return state._dataSource;
    const dataSource = new Cesium.CustomDataSource('events');
    dataSource.show = false;
    viewer.dataSources.add(dataSource);
    state._dataSource = dataSource;
    installClusterStyling();
    return dataSource;
  }

  function installClusterStyling() {
    const dataSource = state._dataSource;
    if (!dataSource || state._removeClusterListener) return;
    const clustering = dataSource.clustering;
    clustering.enabled = true;
    clustering.pixelRange = CLUSTER_PIXEL_RANGE;
    clustering.minimumClusterSize = CLUSTER_MIN_SIZE;
    clustering.clusterBillboards = true;
    clustering.clusterLabels = false;
    clustering.clusterPoints = false;
    state._removeClusterListener = clustering.clusterEvent.addEventListener(
      (clusteredEntities, cluster) => {
        const events = [];
        for (const entity of clusteredEntities) {
          const event = state._eventById.get(entity.id);
          if (event) events.push(event);
        }
        const summary = summarizeCluster(events);
        cluster.label.show = false;
        cluster.point.show = false;
        cluster.billboard.show = true;
        // A string id with the layer's prefix keeps sibling layers' click
        // handlers from reading a cluster as empty map; the members ride along
        // for this layer's own pick resolution.
        cluster.billboard.id = {
          id: `${EVENT_CLUSTER_PICK_PREFIX}${summary.kind}:${events.length}`,
          events,
        };
        cluster.billboard.image = state._icons.cluster(events.length, summary.kind);
        cluster.billboard.width = CLUSTER_SIZE_PX;
        cluster.billboard.height = CLUSTER_SIZE_PX;
        cluster.billboard.verticalOrigin = Cesium.VerticalOrigin.CENTER;
        cluster.billboard.horizontalOrigin = Cesium.HorizontalOrigin.CENTER;
        cluster.billboard.disableDepthTestDistance = Number.POSITIVE_INFINITY;
        cluster.billboard.scaleByDistance = scaleByDistance;
      },
    );
  }

  /**
   * Bring the entity set in line with a ranked cohort: add new events, move
   * or re-skin changed ones, remove the rest. Identity is the pick id, so an
   * unchanged event keeps its entity (and its cluster membership history).
   * @param {object[]} events
   * @returns {{added: number, updated: number, removed: number}}
   */
  function reconcile(events) {
    const dataSource = state._dataSource;
    if (!dataSource) return { added: 0, updated: 0, removed: 0 };
    const keep = new Set();
    let added = 0;
    let updated = 0;
    let removed = 0;
    const nextById = new Map();
    for (const event of events) {
      keep.add(event.pickId);
      nextById.set(event.pickId, event);
      const previous = state._eventById.get(event.pickId);
      let entity = state._entityById.get(event.pickId);
      const moved =
        !previous ||
        previous.lat !== event.lat ||
        previous.lon !== event.lon ||
        previous.altitudeM !== event.altitudeM;
      if (!entity) {
        entity = dataSource.entities.add({
          id: event.pickId,
          position: positionFor(event),
          billboard: {
            image: state._icons.icon(event.kind),
            width: ICON_SIZE_PX,
            height: ICON_SIZE_PX,
            verticalOrigin: verticalOriginFor(event.kind),
            horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            scaleByDistance,
          },
        });
        state._entityById.set(event.pickId, entity);
        added += 1;
      } else {
        if (moved) entity.position = positionFor(event);
        if (previous?.kind !== event.kind) {
          entity.billboard.image = state._icons.icon(event.kind);
          entity.billboard.verticalOrigin = verticalOriginFor(event.kind);
        }
        if (moved || previous?.kind !== event.kind) updated += 1;
      }
    }
    for (const [pickId, entity] of state._entityById) {
      if (keep.has(pickId)) continue;
      dataSource.entities.remove(entity);
      state._entityById.delete(pickId);
      removed += 1;
    }
    state._eventById = nextById;
    state._events = events;
    // A changed collection needs one frame even when the camera is parked.
    if (added || updated || removed) {
      state._lastHorizonSignature = null;
      governorRequestRender('events-reconcile');
    }
    return { added, updated, removed };
  }

  /**
   * Hide icons behind the globe. Depth testing is off so the ellipsoid does
   * not occlude them; this pass does, on data changes and camera stops.
   * @param {{force?: boolean}} [options]
   */
  function applyHorizon({ force = false } = {}) {
    const camera = state._viewer?.camera;
    if (!camera || !state._entityById.size) return;
    const signature = cameraPoseSignature(camera);
    if (!force && signature === state._lastHorizonSignature) return;
    state._lastHorizonSignature = signature;
    const occluder = horizonOccluder(camera);
    const now = Cesium.JulianDate.now();
    let changed = false;
    for (const entity of state._entityById.values()) {
      const position = entity.position?.getValue?.(now);
      const visible = !position || occluder.isPointVisible(position);
      if (entity.show !== visible) {
        entity.show = visible;
        changed = true;
      }
    }
    if (changed) governorRequestRender('events-horizon');
  }

  /** Re-skin every icon after the theme palette changes. */
  function refreshIcons() {
    for (const [pickId, entity] of state._entityById) {
      const event = state._eventById.get(pickId);
      if (event) entity.billboard.image = state._icons.icon(event.kind);
    }
    governorRequestRender('events-theme');
  }

  function setVisible(visible) {
    if (state._dataSource) state._dataSource.show = visible;
    governorRequestRender('events-visibility');
  }

  function clear() {
    if (state._dataSource) state._dataSource.entities.removeAll();
    state._entityById.clear();
    state._eventById = new Map();
    state._events = [];
    state._lastHorizonSignature = null;
  }

  function destroyDataSource(viewer) {
    state._removeClusterListener?.();
    state._removeClusterListener = null;
    if (state._dataSource) {
      viewer?.dataSources?.remove(state._dataSource, true);
      state._dataSource = null;
    }
    state._entityById.clear();
    state._eventById = new Map();
    state._events = [];
  }

  return {
    positionFor,
    ensureDataSource,
    installClusterStyling,
    reconcile,
    applyHorizon,
    refreshIcons,
    setVisible,
    clear,
    destroyDataSource,
  };
}
