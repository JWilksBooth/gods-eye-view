import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  bindTrackingClickGesture,
  isTrackingClickGesture,
} from '../../data/trackingClickGesture.js';
import { isEventPickId, summarizeCluster } from './model.js';
import {
  EVENTS_LAYER_ID,
  HOVER_PICK_THROTTLE_MS,
  HOVER_RELEASE_MS,
} from './policy.js';

/**
 * Pointer handling: a throttled hover pick on MOUSE_MOVE (never per frame),
 * clean-tap clicks through the shared tracking-click gesture, and pick
 * ownership so sibling layers leave event icons and clusters alone.
 */
export function createInteraction({ state, services, parts }) {
  const { registerPickOwner, unregisterPickOwner, resolvePickId, isOwnedByOtherLayer } =
    services.picking;

  /**
   * What a scene pick names: one event, a cluster's members, or nothing.
   * @param {object|null} picked Result of `scene.pick()`.
   * @returns {{event: object}|{cluster: object[]}|null}
   */
  function resolvePick(picked) {
    if (!picked) return null;
    for (const carrier of [picked.id, picked.primitive?.id]) {
      if (!carrier) continue;
      if (typeof carrier === 'string') {
        const event = state._eventById.get(carrier);
        if (event) return { event };
        continue;
      }
      if (typeof carrier !== 'object') continue;
      if (Array.isArray(carrier.events) && isEventPickId(carrier.id)) {
        const members = carrier.events.filter((event) =>
          state._eventById.has(event.pickId),
        );
        return members.length ? { cluster: members } : null;
      }
      if (typeof carrier.id === 'string') {
        const event = state._eventById.get(carrier.id);
        if (event) return { event };
      }
    }
    return null;
  }

  function pickAt(position) {
    const scene = state._viewer?.scene;
    if (!scene || !position) return null;
    let picked = null;
    try {
      picked = scene.pick(position);
    } catch {
      return null;
    }
    const hit = resolvePick(picked);
    if (hit) return hit;
    const pickId = resolvePickId(picked);
    if (pickId && isOwnedByOtherLayer(EVENTS_LAYER_ID, pickId)) return null;
    return null;
  }

  function presentationAllowed() {
    return state._enabled && !!state._viewer && !state._viewer.isDestroyed?.();
  }

  function clearHover() {
    state._hoverKey = null;
    state._hoverLastPickAt = 0;
    parts.hoverCard.hide();
  }

  /**
   * Throttled hover pass. A still pointer costs nothing; a moving pointer
   * over empty map performs one pick per throttle and writes no DOM.
   * @param {{x: number, y: number}} position
   */
  function handleHoverMove(position) {
    if (!presentationAllowed() || !position) return;
    if (state._cameraMoving) {
      if (state._hoverKey) clearHover();
      return;
    }
    const now = Date.now();
    if (now - state._hoverLastPickAt < HOVER_PICK_THROTTLE_MS) {
      if (state._hoverKey) parts.hoverCard.move(position);
      return;
    }
    state._hoverLastPickAt = now;
    const hit = pickAt(position);
    if (hit?.event) {
      state._hoverKey = hit.event.pickId;
      parts.hoverCard.show(hit.event, position);
      return;
    }
    if (hit?.cluster) {
      const summary = summarizeCluster(hit.cluster);
      state._hoverKey = `cluster:${hit.cluster.length}`;
      parts.hoverCard.showCluster(summary, position);
      return;
    }
    if (state._hoverKey) {
      state._hoverKey = null;
      parts.hoverCard.scheduleHide(HOVER_RELEASE_MS);
    }
  }

  function handleClick(click) {
    if (!presentationAllowed() || !isPointerFree()) return;
    const hit = pickAt(click?.position);
    if (!hit) return;
    clearHover();
    if (hit.event) {
      services.feed?.open?.(hit.event, { origin: 'click' });
      dispatchSelected({ pickId: hit.event.pickId, kind: hit.event.kind });
    } else if (hit.cluster) {
      services.feed?.openCluster?.(hit.cluster, { origin: 'click' });
      dispatchSelected({ cluster: hit.cluster.length });
    }
  }

  function dispatchSelected(detail) {
    if (typeof document === 'undefined') return;
    document.dispatchEvent(new CustomEvent('gev:event-selected', { detail }));
  }

  function install() {
    const viewer = state._viewer;
    if (!viewer || state._handler) return;
    registerPickOwner(EVENTS_LAYER_ID, (id) => isEventPickId(id));
    state._handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    bindTrackingClickGesture(
      state._handler,
      (click, gesture) => {
        if (!isTrackingClickGesture(gesture)) return;
        handleClick(click);
      },
      { onMouseMove: (movement) => handleHoverMove(movement?.endPosition) },
    );
  }

  function remove() {
    unregisterPickOwner(EVENTS_LAYER_ID);
    state._handler?.destroy();
    state._handler = null;
    clearHover();
  }

  return {
    resolvePick,
    pickAt,
    handleHoverMove,
    handleClick,
    clearHover,
    install,
    remove,
  };
}
