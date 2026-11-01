import * as Cesium from 'cesium';
import { createStreamsLayer } from '../../layers/streams/index.js';
import { createStreamsEventAdapter } from '../../layers/streams/eventAdapter.js';
import { registerEventAdapter } from '../../layers/events/adapters.js';
import { eventPickId } from '../../layers/events/model.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';
import { isPointerFree } from '../../data/inputOwnership.js';

const EVENT_MAP_LAYER_ID = 'events';

/** The page's value of a theme token, or an empty string outside a document. */
function readThemeToken(name) {
  const root = globalThis.document?.documentElement;
  if (!root || typeof globalThis.getComputedStyle !== 'function') return '';
  return globalThis.getComputedStyle(root).getPropertyValue(name);
}

/**
 * Wire live streams into the application catalog and onto the event map.
 *
 * The layer draws its own points while the event map is off; the adapter
 * registered here puts the same streams on the event map as `stream` icons
 * whose click opens the feed drawer. Opening a stream from this layer's
 * own card goes to the drawer when the event map is on, and to the
 * provider's own page otherwise, so a player is only ever created by the
 * drawer, on a click.
 */
export function createApplicationStreams(options) {
  let manager = null;
  const openExternal = (url) => {
    if (!url) return false;
    globalThis.open?.(url, '_blank', 'noopener,noreferrer');
    return true;
  };
  function openInEventMap(row) {
    const events = manager?.layers?.get?.(EVENT_MAP_LAYER_ID)?.module;
    if (!events?.openEvent || manager?.isEnabled?.(EVENT_MAP_LAYER_ID) !== true)
      return false;
    try {
      events.refresh?.();
      return events.openEvent(eventPickId('streams', row.id)) === true;
    } catch (error) {
      console.warn('[Streams] event map hand-off failed:', error);
      return false;
    }
  }
  const layer = createStreamsLayer({
    overlayHost: {
      setEntries: overlays.setOverlayEntries,
      setVisible: overlays.setOverlaySourceVisible,
      clearSource: overlays.clearOverlaySource,
      hitTest: overlays.hitTestWorldOverlay,
    },
    openStream: (row) => openInEventMap(row) || openExternal(row.pageUrl),
    readToken: readThemeToken,
    screenSpaceEventHandlerFactory: (viewer) =>
      new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
    picking,
    pointer: { isPointerFree },
    ...options,
  });
  const unregister = registerEventAdapter(createStreamsEventAdapter({ layer }));
  const attachDataManager = layer.attachDataManager;
  layer.attachDataManager = (next) => {
    manager = next;
    attachDataManager(next);
  };
  const destroy = layer.destroy;
  layer.destroy = (viewer) => {
    unregister();
    manager = null;
    destroy(viewer);
  };
  return layer;
}
