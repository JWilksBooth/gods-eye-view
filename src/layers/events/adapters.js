/**
 * @module layers/events/adapters
 * @description The event-source registry behind the Event Map layer.
 *
 * Any layer can put its records on the event map by registering an
 * ADAPTER: a small object that knows how to list the layer's current
 * records as plain {@link MapEvent}s and, optionally, what the feed drawer
 * should show when one is clicked. The event layer owns rendering,
 * clustering, hover cards, picking and the drawer; an adapter owns only
 * data. Registration is page-scoped, like the pick registry, so an adapter
 * written for a layer the catalog constructs registers once at construction
 * and unregisters on destroy.
 *
 * Minimal registration (three lines):
 *
 * ```js
 * import { registerEventAdapter } from '../events/adapters.js';
 * registerEventAdapter({
 *   id: 'incidents',
 *   kind: 'incident',
 *   layerId: 'incidents',
 *   getEvents: ({ limit }) => incidents.getRecords().slice(0, limit).map((r) => ({
 *     id: r.id, lat: r.lat, lon: r.lon, title: r.title,
 *     description: r.summary, source: r.agency, time: r.updatedAtMs,
 *   })),
 * });
 * ```
 *
 * The layer reads adapters only while it is enabled, and an adapter with a
 * `layerId` only while that layer is enabled too, so a source never has to
 * check the manager itself. It is read again when the manager reports new
 * data for `layerId`, when the camera stops moving, on the layer's periodic
 * refresh, and whenever the adapter calls the `notify` function handed to
 * its optional `subscribe`.
 */

/**
 * @typedef {'camera'|'stream'|'fire'|'quake'|'aircraft'|'vessel'|'incident'|'alert'} EventKind
 */

/**
 * @typedef {object} MapEvent
 * @property {string} id Stable within the adapter (a camera id, a USGS id).
 * @property {number} lat Degrees.
 * @property {number} lon Degrees.
 * @property {EventKind} [kind] Defaults to the adapter's kind.
 * @property {number} [altitudeM] Height above the ellipsoid for airborne
 *   events; ground events omit it and sit on the cached ground floor.
 * @property {string} title One line: a camera name, "M 4.2 near Ridgecrest".
 * @property {string} [description] One line for the hover card.
 * @property {string} [source] Provider or credit shown in the card.
 * @property {number} [time] Epoch ms of the observation, shown as freshness.
 * @property {number} [priority] Higher wins when the cohort is capped (0).
 * @property {object} [data] Adapter-private payload for `feed()`.
 */

/**
 * @typedef {object} EventQueryContext
 * @property {number} limit Most events the layer wants from this adapter.
 * @property {{lat: number, lon: number}|null} center The camera's ground
 *   point, for nearest-first ranking when a source has more than `limit`.
 * @property {number} now Epoch ms.
 */

/**
 * What the feed drawer shows for an event. `type` selects a renderer:
 *  - `camera`: `{ type: 'camera', cameraId, layerId }`, the CCTV snapshot and,
 *    for video feeds, the layer's bounded HLS decoder.
 *  - `stream`: `{ type: 'stream', embed: { kind: 'youtube', videoId } |
 *    { kind: 'hls', url } | { kind: 'mjpeg', url } | { kind: 'link', url },
 *    poster?, terms?, owner? }`, created on open and destroyed on close.
 *  - `detail`: `{ type: 'detail', lines: string[], nearestCameras?: boolean,
 *    actions?: Array<{ label: string, run: () => void }> }`.
 * `null` falls back to a detail view of the event's own fields.
 * @typedef {object} EventFeed
 * @property {'camera'|'stream'|'detail'} type
 */

/**
 * @typedef {object} EventAdapter
 * @property {string} id Unique adapter id, e.g. 'cctv'.
 * @property {EventKind} kind Default kind of every event it publishes.
 * @property {string} [layerId] Data-manager layer whose records it reads;
 *   when set, the adapter is read only while that layer is enabled.
 * @property {(context: EventQueryContext) => MapEvent[]} getEvents
 *   Synchronous snapshot of the source's current records, already bounded.
 * @property {(event: MapEvent) => EventFeed|null} [feed]
 *   What the drawer shows for one of its events.
 * @property {(notify: () => void) => (() => void)} [subscribe]
 *   Optional change notification; returns an unsubscribe function.
 */

/** @type {Map<string, EventAdapter>} */
const _adapters = new Map();
/** @type {Set<(change: {type: string, id: string}) => void>} */
const _listeners = new Set();

const KINDS = new Set([
  'camera',
  'stream',
  'fire',
  'quake',
  'aircraft',
  'vessel',
  'incident',
  'alert',
]);

/** Every kind the registry accepts, for sources that build events by name. */
export const EVENT_ADAPTER_KINDS = Object.freeze([...KINDS]);

/**
 * Validate an adapter shape. Throws a TypeError naming the first problem so a
 * mis-registered source fails at construction, not at the first refresh.
 * @param {EventAdapter} adapter
 * @returns {EventAdapter} The same adapter.
 */
export function assertEventAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object')
    throw new TypeError('An event adapter must be an object');
  if (typeof adapter.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(adapter.id))
    throw new TypeError('An event adapter needs a short lowercase id');
  if (!KINDS.has(adapter.kind))
    throw new TypeError(
      `Event adapter ${adapter.id} has an unknown kind: ${adapter.kind}`,
    );
  if (typeof adapter.getEvents !== 'function')
    throw new TypeError(`Event adapter ${adapter.id} needs getEvents()`);
  if (adapter.layerId !== undefined && typeof adapter.layerId !== 'string')
    throw new TypeError(`Event adapter ${adapter.id} layerId must be a string`);
  if (adapter.feed !== undefined && typeof adapter.feed !== 'function')
    throw new TypeError(`Event adapter ${adapter.id} feed must be a function`);
  if (adapter.subscribe !== undefined && typeof adapter.subscribe !== 'function')
    throw new TypeError(
      `Event adapter ${adapter.id} subscribe must be a function`,
    );
  return adapter;
}

function notify(change) {
  for (const listener of [..._listeners]) {
    try {
      listener(change);
    } catch (error) {
      console.warn('[Events] adapter listener error:', error);
    }
  }
}

/**
 * Register an adapter. Re-registering an id replaces the earlier adapter.
 * @param {EventAdapter} adapter
 * @returns {() => void} Unregister function.
 */
export function registerEventAdapter(adapter) {
  assertEventAdapter(adapter);
  _adapters.set(adapter.id, adapter);
  notify({ type: 'registered', id: adapter.id });
  return () => unregisterEventAdapter(adapter.id, adapter);
}

/**
 * Remove an adapter. With `expected`, only that exact adapter is removed, so
 * a stale unregister cannot evict a replacement.
 * @param {string} id
 * @param {EventAdapter} [expected]
 * @returns {boolean} Whether an adapter was removed.
 */
export function unregisterEventAdapter(id, expected) {
  const current = _adapters.get(id);
  if (!current || (expected && current !== expected)) return false;
  _adapters.delete(id);
  notify({ type: 'unregistered', id });
  return true;
}

/** Registered adapters in registration order. */
export function listEventAdapters() {
  return [..._adapters.values()];
}

/** One adapter by id, or undefined. */
export function getEventAdapter(id) {
  return _adapters.get(id);
}

/**
 * Observe registrations, so the layer can refresh when a source joins late.
 * @param {(change: {type: string, id: string}) => void} listener
 * @returns {() => void} Unsubscribe.
 */
export function subscribeEventAdapters(listener) {
  if (typeof listener !== 'function') return () => {};
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

/** Test seam: empty the page-scoped registry. */
export function _resetEventAdaptersForTest() {
  _adapters.clear();
  _listeners.clear();
}

/* ------------------------------------------------------------------ */
/* Stubs for layers built alongside this framework. Each is a complete */
/* registration; uncomment it in the layer's application wiring once   */
/* the layer exposes the accessor it names.                            */
/* ------------------------------------------------------------------ */

// Incidents (LIVE OPS regions): one icon per open incident.
// import { registerEventAdapter } from '../events/adapters.js';
// registerEventAdapter({
//   id: 'incidents',
//   kind: 'incident',
//   layerId: 'incidents',
//   getEvents: ({ limit }) =>
//     incidentsLayer.getIncidents().slice(0, limit).map((incident) => ({
//       id: incident.id,
//       lat: incident.lat,
//       lon: incident.lon,
//       title: incident.title,
//       description: incident.summary,
//       source: incident.agency,
//       time: incident.updatedAtMs,
//       priority: incident.severity,
//       data: { incidentId: incident.id },
//     })),
//   feed: (event) => ({
//     type: 'detail',
//     nearestCameras: true,
//     lines: incidentsLayer.describe(event.data.incidentId),
//   }),
// });

// Alerts (warnings and watches): one icon at each alert's centroid.
// registerEventAdapter({
//   id: 'alerts',
//   kind: 'alert',
//   layerId: 'alerts',
//   getEvents: ({ limit }) =>
//     alertsLayer.getAlerts().slice(0, limit).map((alert) => ({
//       id: alert.id,
//       lat: alert.lat,
//       lon: alert.lon,
//       title: alert.headline,
//       description: alert.event,
//       source: alert.sender,
//       time: alert.sentMs,
//       priority: alert.urgency,
//     })),
// });
