import { greatCircleKm } from '../../geoDistance.js';
import {
  EVENT_CLUSTER_PICK_PREFIX,
  EVENT_KIND_LABELS,
  EVENT_KINDS,
  EVENT_PICK_PREFIX,
  STALE_AFTER_MS,
} from './policy.js';

const KIND_SET = new Set(EVENT_KINDS);

const text = (value) => {
  const trimmed = String(value ?? '').trim();
  return trimmed || null;
};

const finite = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/** The pick id of one event: `event:<adapter>:<id>`, the id URI-encoded. */
export function eventPickId(adapterId, id) {
  return `${EVENT_PICK_PREFIX}${adapterId}:${encodeURIComponent(String(id))}`;
}

/**
 * Split a pick id back into its adapter and record ids; null for ids that
 * are not an event's (including cluster ids).
 * @param {string} pickId
 * @returns {{adapterId: string, id: string}|null}
 */
export function parseEventPickId(pickId) {
  const value = String(pickId ?? '');
  if (
    !value.startsWith(EVENT_PICK_PREFIX) ||
    value.startsWith(EVENT_CLUSTER_PICK_PREFIX)
  )
    return null;
  const rest = value.slice(EVENT_PICK_PREFIX.length);
  const separator = rest.indexOf(':');
  if (separator <= 0 || separator === rest.length - 1) return null;
  try {
    return {
      adapterId: rest.slice(0, separator),
      id: decodeURIComponent(rest.slice(separator + 1)),
    };
  } catch {
    return null;
  }
}

/** Whether a pick id names one of this layer's icons or clusters. */
export function isEventPickId(pickId) {
  return String(pickId ?? '').startsWith(EVENT_PICK_PREFIX);
}

/**
 * Validate and complete one adapter record. Returns null for records the
 * layer cannot place (no id, no finite position) so one bad row never drops
 * a source's whole snapshot.
 * @param {object} raw An adapter's MapEvent.
 * @param {{id: string, kind: string}} adapter
 * @returns {object|null} The normalized event with `pickId` and `adapterId`.
 */
export function normalizeEvent(raw, adapter) {
  const id = text(raw?.id);
  const lat = finite(raw?.lat);
  const lon = finite(raw?.lon);
  if (!id || lat === null || lon === null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const kind = KIND_SET.has(raw?.kind) ? raw.kind : adapter.kind;
  const altitudeM = finite(raw?.altitudeM);
  const time = finite(raw?.time);
  return {
    pickId: eventPickId(adapter.id, id),
    adapterId: adapter.id,
    id,
    kind,
    lat,
    lon,
    altitudeM: altitudeM === null ? null : altitudeM,
    title: text(raw?.title) || id,
    description: text(raw?.description),
    source: text(raw?.source),
    time: time !== null && time > 0 ? time : null,
    priority: finite(raw?.priority) ?? 0,
    data: raw?.data && typeof raw.data === 'object' ? raw.data : null,
  };
}

/** The English label of a kind, for translation at the presentation edge. */
export function eventKindLabel(kind) {
  return EVENT_KIND_LABELS[kind] || EVENT_KIND_LABELS.incident;
}

/**
 * Freshness of an observation as a plain descriptor the hover card formats.
 * @param {number|null} timeMs
 * @param {number} nowMs
 * @returns {{state: 'unknown'|'live'|'recent'|'stale', ageMs: number|null}}
 */
export function describeFreshness(timeMs, nowMs = Date.now()) {
  if (!Number.isFinite(timeMs) || timeMs <= 0)
    return { state: 'unknown', ageMs: null };
  const ageMs = Math.max(0, nowMs - timeMs);
  if (ageMs < 90_000) return { state: 'live', ageMs };
  if (ageMs < STALE_AFTER_MS) return { state: 'recent', ageMs };
  return { state: 'stale', ageMs };
}

/**
 * The relative-time unit and value Intl.RelativeTimeFormat wants for an age.
 * @param {number} ageMs
 * @returns {{value: number, unit: 'minute'|'hour'|'day'}}
 */
export function relativeAge(ageMs) {
  const minutes = Math.round(ageMs / 60_000);
  if (minutes < 60) return { value: -Math.max(1, minutes), unit: 'minute' };
  const hours = Math.round(ageMs / 3_600_000);
  if (hours < 48) return { value: -hours, unit: 'hour' };
  return { value: -Math.round(ageMs / 86_400_000), unit: 'day' };
}

/**
 * Rank events for a capped cohort: higher priority first, then nearest the
 * camera's ground point, then a stable id order so ties do not flicker.
 * @param {object[]} events Normalized events.
 * @param {{center?: {lat: number, lon: number}|null, limit?: number}} options
 * @returns {object[]} A new array of at most `limit` events.
 */
export function rankEvents(events, { center = null, limit = Infinity } = {}) {
  const distance = (event) =>
    center ? greatCircleKm(center, { lat: event.lat, lon: event.lon }) : 0;
  const scored = events.map((event) => ({ event, km: distance(event) }));
  scored.sort(
    (a, b) =>
      b.event.priority - a.event.priority ||
      a.km - b.km ||
      a.event.pickId.localeCompare(b.event.pickId),
  );
  const cap = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : scored.length;
  return scored.slice(0, cap).map((entry) => entry.event);
}

/**
 * Describe a cluster for its hover card: the count, the dominant kind and
 * a per-kind breakdown in descending order.
 * @param {object[]} events
 * @returns {{count: number, kind: string, breakdown: Array<{kind: string, count: number}>}}
 */
export function summarizeCluster(events) {
  const counts = new Map();
  for (const event of events) {
    counts.set(event.kind, (counts.get(event.kind) || 0) + 1);
  }
  const breakdown = [...counts]
    .map(([kind, count]) => ({ kind, count }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        EVENT_KINDS.indexOf(a.kind) - EVENT_KINDS.indexOf(b.kind),
    );
  return {
    count: events.length,
    kind: breakdown[0]?.kind || 'incident',
    breakdown,
  };
}

/**
 * The nearest events of a kind to a point, for "nearest cameras" lists.
 * @param {object[]} events
 * @param {{lat: number, lon: number}} point
 * @param {{kind?: string, limit?: number, maxKm?: number}} options
 * @returns {Array<{event: object, km: number}>}
 */
export function nearestEvents(
  events,
  point,
  { kind = null, limit = 5, maxKm = Infinity } = {},
) {
  const rows = [];
  for (const event of events) {
    if (kind && event.kind !== kind) continue;
    const km = greatCircleKm(point, { lat: event.lat, lon: event.lon });
    if (!Number.isFinite(km) || km > maxKm) continue;
    rows.push({ event, km });
  }
  rows.sort((a, b) => a.km - b.km || a.event.pickId.localeCompare(b.event.pickId));
  return rows.slice(0, Math.max(0, Math.floor(limit)));
}

/**
 * The voice/pick descriptor of an event, shaped like the other layers'
 * `findByQuery` answers (src/data/pickedContext.js).
 * @param {object} event Normalized event.
 */
export function describeEvent(event) {
  if (!event) return null;
  return {
    name: event.title,
    kind: event.kind,
    adapterId: event.adapterId,
    id: event.id,
    pickId: event.pickId,
    latitude: event.lat,
    longitude: event.lon,
    altitudeM: event.altitudeM,
    source: event.source,
    time: event.time,
  };
}
