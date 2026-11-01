import { createState } from './state.js';
import { createRendering } from './rendering.js';
import { createEventHoverCard } from './hoverCard.js';
import { createInteraction } from './interaction.js';
import { createLifecycle } from './lifecycle.js';

/**
 * Compose one event map layer with explicit scene services.
 *
 * @param {object} options
 * @param {object} options.services
 * @param {object} options.services.picking src/data/pickRegistry.js
 * @param {object} options.services.ground The surface ground-floor service.
 * @param {object} options.services.render src/renderGovernor.js
 * @param {{readCameraCenter: (viewer: object) => ({lat: number, lon: number}|null)}} options.services.camera
 * @param {{open: Function, openCluster: Function}} [options.services.feed]
 *   The feed drawer; without one, clicks only announce `gev:event-selected`.
 * @param {Document} [options.documentRef]
 */
export function createEventsLayer({ services, documentRef = globalThis.document }) {
  for (const key of ['picking', 'ground', 'render', 'camera']) {
    if (!services?.[key]) throw new TypeError(`Event layer needs services.${key}`);
  }
  const state = createState();
  const parts = {};
  const context = { state, services, parts };
  parts.rendering = createRendering(context);
  parts.hoverCard = createEventHoverCard({ documentRef });
  parts.interaction = createInteraction(context);
  parts.lifecycle = createLifecycle(context);
  return Object.assign({}, parts.lifecycle.methods, {
    _partsForTest: parts,
  });
}

export {
  registerEventAdapter,
  unregisterEventAdapter,
  listEventAdapters,
  getEventAdapter,
  subscribeEventAdapters,
  assertEventAdapter,
  EVENT_ADAPTER_KINDS,
} from './adapters.js';
export {
  EVENTS_LAYER_ID,
  EVENT_KINDS,
  EVENT_KIND_LABELS,
  EVENT_PICK_PREFIX,
} from './policy.js';
export {
  eventPickId,
  parseEventPickId,
  isEventPickId,
  normalizeEvent,
  rankEvents,
  summarizeCluster,
  describeFreshness,
  nearestEvents,
} from './model.js';
