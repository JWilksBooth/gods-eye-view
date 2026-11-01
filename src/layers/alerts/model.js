/**
 * @module layers/alerts/model
 *
 * One normalized alert shape for every official alert and status feed, plus
 * the pure helpers the server proxy, the portable source, the tools and the
 * renderer share. No Cesium, no DOM, no network.
 *
 * An alert is:
 *
 *   {
 *     id, source, kind, severity, agency, headline, body, instruction,
 *     area, areaSource, areaDescription, regions,
 *     starts, ends, issued, updated, url, fetchedAt, freshness
 *   }
 *
 * `area` is GeoJSON (Point, Polygon or MultiPolygon) or null when the feed
 * gave no geometry; `areaSource` says how the geometry was obtained
 * (`feed` as the feed published it, `zones` from NWS zone shapes, `centroid`
 * of a named county, `site` for a fixed facility such as an airport, or
 * null). `regions` are LIVE OPS region ids (src/data/liveOpsRegions.js).
 * Times are ISO 8601 strings or null. `freshness` is `live` when the proxy's
 * copy of the feed is within its refresh interval and `stale` when it is
 * serving an older copy because the feed could not be reached.
 */
import { msg } from '../../i18n/marker.js';
import { ALERT_REGION_IDS } from './regions.js';

export const ALERTS_LAYER_ID = 'alerts';
export const ALERTS_OVERLAY_SOURCE_ID = 'alerts';

/** Longest headline kept. Feeds pad headlines with dates; the card shows the start. */
export const ALERT_HEADLINE_MAX = 200;
/** Longest body kept: enough to read, not a whole bulletin. */
export const ALERT_BODY_MAX = 1500;
export const ALERT_INSTRUCTION_MAX = 600;
export const ALERT_AREA_DESCRIPTION_MAX = 300;

/**
 * Severity bands, worst first. `token` is the CSS custom property the theme
 * paints the band with (src/ui/styles/alerts.css). Colours live only in the
 * stylesheet: the renderer resolves the tokens, and nothing here names one.
 */
export const ALERT_SEVERITIES = Object.freeze([
  Object.freeze({
    id: 'extreme',
    rank: 4,
    label: msg('Extreme'),
    token: '--alert-severity-extreme',
  }),
  Object.freeze({
    id: 'severe',
    rank: 3,
    label: msg('Severe'),
    token: '--alert-severity-severe',
  }),
  Object.freeze({
    id: 'moderate',
    rank: 2,
    label: msg('Moderate'),
    token: '--alert-severity-moderate',
  }),
  Object.freeze({
    id: 'minor',
    rank: 1,
    label: msg('Minor'),
    token: '--alert-severity-minor',
  }),
  Object.freeze({
    id: 'unknown',
    rank: 0,
    label: msg('Unknown severity'),
    token: '--alert-severity-unknown',
  }),
]);

/** Severity ids, worst first. */
export const ALERT_SEVERITY_IDS = Object.freeze(
  ALERT_SEVERITIES.map((band) => band.id),
);

const SEVERITY_BY_ID = new Map(ALERT_SEVERITIES.map((band) => [band.id, band]));

/** The kinds of alert the feeds produce, in legend order. */
export const ALERT_KINDS = Object.freeze([
  Object.freeze({ id: 'weather', label: msg('Weather') }),
  Object.freeze({ id: 'fire', label: msg('Fire') }),
  Object.freeze({ id: 'air', label: msg('Air quality') }),
  Object.freeze({ id: 'road', label: msg('Roads') }),
  Object.freeze({ id: 'transit', label: msg('Transit') }),
  Object.freeze({ id: 'airport', label: msg('Airports') }),
  Object.freeze({ id: 'emergency', label: msg('Emergency') }),
  Object.freeze({ id: 'advisory', label: msg('Advisory') }),
]);

export const ALERT_KIND_IDS = Object.freeze(ALERT_KINDS.map((kind) => kind.id));
const KIND_BY_ID = new Map(ALERT_KINDS.map((kind) => [kind.id, kind]));

/** How the geometry of an alert was obtained. */
export const ALERT_AREA_SOURCES = Object.freeze([
  'feed',
  'zones',
  'centroid',
  'site',
]);

/**
 * Airport status kinds the FAA feed reports, with the severity each maps to
 * and the English name server-built text uses (feed data, not UI copy).
 * `restriction` is an airport "closed to" some traffic (a NOTAM that keeps
 * scheduled flights running), which the FAA lists among closures.
 */
export const AIRPORT_STATUS_KINDS = Object.freeze({
  closure: Object.freeze({ severity: 'severe', name: 'Airport closure' }),
  ground_stop: Object.freeze({ severity: 'severe', name: 'Ground stop' }),
  ground_delay: Object.freeze({
    severity: 'moderate',
    name: 'Ground delay program',
  }),
  delay: Object.freeze({ severity: 'minor', name: 'Delays' }),
  restriction: Object.freeze({ severity: 'minor', name: 'Airport restriction' }),
});

/** The severity descriptor for an id, or the unknown band. */
export function alertSeverity(id) {
  return SEVERITY_BY_ID.get(String(id ?? '')) || SEVERITY_BY_ID.get('unknown');
}

/** 0 (unknown) to 4 (extreme). */
export function severityRank(id) {
  return alertSeverity(id).rank;
}

/**
 * A severity id from free text: NWS/CAP words, GTFS severity levels and
 * common synonyms. Anything else is `unknown`.
 */
export function normalizeSeverity(value) {
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!text) return 'unknown';
  if (SEVERITY_BY_ID.has(text)) return text;
  if (/^(extreme|critical|emergency)$/.test(text)) return 'extreme';
  if (/^(severe|major|high|warning)$/.test(text)) return 'severe';
  if (/^(moderate|medium|watch)$/.test(text)) return 'moderate';
  if (/^(minor|low|info|information|advisory|statement)$/.test(text))
    return 'minor';
  return 'unknown';
}

/** The kind descriptor for an id, or null. */
export function alertKind(id) {
  return KIND_BY_ID.get(String(id ?? '')) || null;
}

/** Trim, collapse whitespace and cap a text; null when nothing is left. */
export function clampText(value, max) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** An ISO 8601 string for a parsable time, or null. */
export function isoOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms =
    typeof value === 'number' ? value : Date.parse(String(value).trim());
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Epoch milliseconds for an ISO string, or null. */
export function msOrNull(iso) {
  if (typeof iso !== 'string') return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** An http(s) URL as a string, or null. */
export function httpUrlOrNull(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function validPosition(position) {
  return (
    Array.isArray(position) &&
    position.length >= 2 &&
    Number.isFinite(position[0]) &&
    Number.isFinite(position[1]) &&
    Math.abs(position[0]) <= 180 &&
    Math.abs(position[1]) <= 90
  );
}

function validRing(ring) {
  return Array.isArray(ring) && ring.length >= 4 && ring.every(validPosition);
}

function validPolygon(rings) {
  return Array.isArray(rings) && rings.length > 0 && rings.every(validRing);
}

/**
 * A copy of a GeoJSON Point, Polygon or MultiPolygon with every coordinate
 * checked, or null for anything else. Coordinates are `[lon, lat]`.
 */
export function validateAlertGeometry(geometry) {
  if (!geometry || typeof geometry !== 'object') return null;
  const { type, coordinates } = geometry;
  if (type === 'Point' && validPosition(coordinates))
    return {
      type: 'Point',
      coordinates: [Number(coordinates[0]), Number(coordinates[1])],
    };
  if (type === 'Polygon' && validPolygon(coordinates))
    return {
      type: 'Polygon',
      coordinates: coordinates.map((ring) =>
        ring.map(([lon, lat]) => [Number(lon), Number(lat)]),
      ),
    };
  if (
    type === 'MultiPolygon' &&
    Array.isArray(coordinates) &&
    coordinates.length > 0 &&
    coordinates.every(validPolygon)
  )
    return {
      type: 'MultiPolygon',
      coordinates: coordinates.map((rings) =>
        rings.map((ring) =>
          ring.map(([lon, lat]) => [Number(lon), Number(lat)]),
        ),
      ),
    };
  return null;
}

/** `[west, south, east, north]` of a validated geometry, or null. */
export function geometryBbox(geometry) {
  const valid = validateAlertGeometry(geometry);
  if (!valid) return null;
  if (valid.type === 'Point') {
    const [lon, lat] = valid.coordinates;
    return [lon, lat, lon, lat];
  }
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const polygons =
    valid.type === 'Polygon' ? [valid.coordinates] : valid.coordinates;
  for (const rings of polygons) {
    for (const [lon, lat] of rings[0]) {
      west = Math.min(west, lon);
      east = Math.max(east, lon);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
  }
  return [west, south, east, north];
}

/** Shoelace area of a ring in degree², relative sizes only. */
function ringArea(ring) {
  let sum = 0;
  for (let i = 1; i < ring.length; i++) {
    const [x1, y1] = ring[i - 1];
    const [x2, y2] = ring[i];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum / 2);
}

/**
 * Where to place an alert's marker and card: the point itself, or the vertex
 * mean of the largest polygon's outer ring. Null without geometry.
 * @returns {{lat: number, lon: number}|null}
 */
export function alertAnchor(alert) {
  const geometry = validateAlertGeometry(alert?.area);
  if (!geometry) return null;
  if (geometry.type === 'Point')
    return { lon: geometry.coordinates[0], lat: geometry.coordinates[1] };
  const polygons =
    geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let best = null;
  let bestArea = -1;
  for (const rings of polygons) {
    const area = ringArea(rings[0]);
    if (area > bestArea) {
      bestArea = area;
      best = rings[0];
    }
  }
  const closed =
    best.length > 1 &&
    best[0][0] === best.at(-1)[0] &&
    best[0][1] === best.at(-1)[1];
  const count = closed ? best.length - 1 : best.length;
  let lon = 0;
  let lat = 0;
  for (let i = 0; i < count; i++) {
    lon += best[i][0];
    lat += best[i][1];
  }
  return { lon: lon / count, lat: lat / count };
}

/**
 * Validate and normalize one alert. Required: `id`, `source`, `kind`,
 * `agency` and `headline`; anything else is optional. Returns null when the
 * required fields are missing so a malformed record is dropped, never
 * displayed half-filled.
 */
export function createAlert(input, { fetchedAt = Date.now() } = {}) {
  if (!input || typeof input !== 'object') return null;
  const id = clampText(input.id, 240);
  const source = clampText(input.source, 40);
  const agency = clampText(input.agency, 120);
  const headline = clampText(input.headline, ALERT_HEADLINE_MAX);
  const kind = KIND_BY_ID.has(input.kind) ? input.kind : null;
  if (!id || !source || !agency || !headline || !kind) return null;
  const area = validateAlertGeometry(input.area);
  const regions = [
    ...new Set(
      (Array.isArray(input.regions) ? input.regions : []).filter((region) =>
        ALERT_REGION_IDS.includes(region),
      ),
    ),
  ];
  return {
    id,
    source,
    kind,
    severity: SEVERITY_BY_ID.has(input.severity)
      ? input.severity
      : normalizeSeverity(input.severity),
    agency,
    headline,
    body: clampText(input.body, ALERT_BODY_MAX),
    instruction: clampText(input.instruction, ALERT_INSTRUCTION_MAX),
    area,
    areaSource:
      area && ALERT_AREA_SOURCES.includes(input.areaSource)
        ? input.areaSource
        : area
          ? 'feed'
          : null,
    areaDescription: clampText(
      input.areaDescription,
      ALERT_AREA_DESCRIPTION_MAX,
    ),
    regions,
    starts: isoOrNull(input.starts),
    ends: isoOrNull(input.ends),
    issued: isoOrNull(input.issued),
    updated: isoOrNull(input.updated),
    url: httpUrlOrNull(input.url),
    fetchedAt: isoOrNull(input.fetchedAt ?? fetchedAt),
    freshness: input.freshness === 'stale' ? 'stale' : 'live',
  };
}

/** How far ahead a scheduled alert still counts as happening now. */
export const ALERT_LOOKAHEAD_MS = 24 * 60 * 60 * 1000;

/**
 * Whether an alert is in force now or starts within the look-ahead. An alert
 * without an end never expires here; the feed drops it when it is over.
 */
export function alertIsCurrent(
  alert,
  now = Date.now(),
  lookaheadMs = ALERT_LOOKAHEAD_MS,
) {
  const ends = msOrNull(alert?.ends);
  if (ends !== null && ends < now) return false;
  const starts = msOrNull(alert?.starts);
  if (starts !== null && starts > now + lookaheadMs) return false;
  return true;
}

/** Worst first, then newest, then by id so the order is stable. */
export function compareAlerts(a, b) {
  const rank = severityRank(b.severity) - severityRank(a.severity);
  if (rank) return rank;
  const time =
    (msOrNull(b.issued) ?? msOrNull(b.starts) ?? 0) -
    (msOrNull(a.issued) ?? msOrNull(a.starts) ?? 0);
  if (time) return time;
  return String(a.id).localeCompare(String(b.id));
}

/**
 * Whether a proxy copy of a feed is still live: within twice its refresh
 * interval of the fetch. Beyond that the copy is being served because the
 * feed cannot be reached and must not be described as live.
 */
export function feedFreshness(fetchedAt, ttlMs, now = Date.now()) {
  const at = typeof fetchedAt === 'number' ? fetchedAt : msOrNull(fetchedAt);
  if (at === null) return 'stale';
  return now - at <= 2 * ttlMs ? 'live' : 'stale';
}

/** Alerts whose anchor or geometry box touches a `[west, south, east, north]` box. */
export function alertTouchesBbox(alert, bbox) {
  const box = geometryBbox(alert?.area);
  if (!box || !Array.isArray(bbox)) return false;
  return !(
    box[2] < bbox[0] ||
    box[0] > bbox[2] ||
    box[3] < bbox[1] ||
    box[1] > bbox[3]
  );
}

/**
 * The alerts a query asks for, order kept: `region` (a region id), `kinds`
 * (kind ids) and `minSeverity` (a severity id; that band and worse). Absent
 * criteria do not filter.
 */
export function filterAlerts(
  alerts,
  { region = null, kinds = null, minSeverity = null } = {},
) {
  const wantedKinds =
    Array.isArray(kinds) && kinds.length ? new Set(kinds) : null;
  const floor = minSeverity ? severityRank(minSeverity) : 0;
  return (Array.isArray(alerts) ? alerts : []).filter(
    (alert) =>
      (!region ||
        (Array.isArray(alert?.regions) && alert.regions.includes(region))) &&
      (!wantedKinds || wantedKinds.has(alert?.kind)) &&
      severityRank(alert?.severity) >= floor,
  );
}

/** Counts of alerts per severity id, every band present. */
export function countBySeverity(alerts) {
  const counts = Object.fromEntries(
    ALERT_SEVERITIES.map((band) => [band.id, 0]),
  );
  for (const alert of alerts || []) {
    const band = alertSeverity(alert?.severity).id;
    counts[band] += 1;
  }
  return counts;
}

/**
 * Map one alert to a JSON-safe analyst record. Pure, no Cesium types.
 * @param {object|null|undefined} alert
 * @param {number} [index=0]
 */
export function mapAlertAnalystRecord(alert, index = 0) {
  const anchor = alertAnchor(alert);
  return {
    id: clampText(alert?.id, 240) || `ALERT-${String(index).padStart(4, '0')}`,
    source: clampText(alert?.source, 40),
    kind: clampText(alert?.kind, 20),
    severity: alertSeverity(alert?.severity).id,
    severityRank: severityRank(alert?.severity),
    agency: clampText(alert?.agency, 120),
    headline: clampText(alert?.headline, ALERT_HEADLINE_MAX),
    regions: Array.isArray(alert?.regions) ? alert.regions.join(' ') : null,
    lat: anchor?.lat ?? null,
    lon: anchor?.lon ?? null,
    startsMs: msOrNull(alert?.starts),
    endsMs: msOrNull(alert?.ends),
    issuedMs: msOrNull(alert?.issued),
  };
}
