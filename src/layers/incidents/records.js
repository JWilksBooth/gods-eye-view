/**
 * The one incident shape every source normalizes to, and the validation the
 * browser applies before a snapshot can replace what it draws.
 *
 * Portable: no Cesium, DOM, Node or i18n. The server providers build rows
 * with `incidentRecord`; the layer, tools and tests read them.
 *
 * A row is `{ id, source, sourceLabel, agency, type, typeDetail, lat, lon,
 * location, area, time, description, region, url }`:
 * - `id` is stable across refreshes (`<source>:<upstream id>`).
 * - `type` is one of INCIDENT_TYPES; `typeDetail` keeps the agency's own
 *   wording ("Trfc Collision-No Inj").
 * - `time` is epoch milliseconds when the agency reported it, or null.
 * - `region` is the LIVE OPS region id the point falls in, or null.
 */

export const INCIDENT_TYPES = Object.freeze([
  'traffic',
  'fire',
  'medical',
  'police',
  'hazard',
  'closure',
  'other',
]);

const TYPE_SET = new Set(INCIDENT_TYPES);

const MAX_TEXT = 240;

/** A trimmed, single-line string capped at `max` characters, or null. */
export function incidentText(value, max = MAX_TEXT) {
  if (value == null || typeof value === 'boolean') return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

/** Epoch milliseconds for a date-like value, or null. */
export function incidentTime(value) {
  if (value == null || value === '') return null;
  const ms = typeof value === 'number' ? value : Date.parse(String(value));
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** An http(s) URL as text, or null. */
export function incidentUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * Build one normalized row. Returns null when the row has no usable
 * identity or position, so a source can skip it.
 */
export function incidentRecord({
  id,
  source,
  sourceLabel,
  agency,
  type,
  typeDetail = null,
  lat,
  lon,
  location = null,
  area = null,
  time = null,
  description = null,
  region = null,
  url = null,
} = {}) {
  const upstreamId = incidentText(id, 120);
  const sourceId = incidentText(source, 40);
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (
    !upstreamId ||
    !sourceId ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  )
    return null;
  return {
    id: `${sourceId}:${upstreamId}`,
    source: sourceId,
    sourceLabel: incidentText(sourceLabel, 80) || sourceId,
    agency: incidentText(agency, 80) || sourceId,
    type: TYPE_SET.has(type) ? type : 'other',
    typeDetail: incidentText(typeDetail, 120),
    lat: Math.round(latitude * 1e6) / 1e6,
    lon: Math.round(longitude * 1e6) / 1e6,
    location: incidentText(location),
    area: incidentText(area, 120),
    time: incidentTime(time),
    description: incidentText(description, 400),
    region: incidentText(region, 40),
    url: incidentUrl(url),
  };
}

/**
 * Validate a `/api/incidents` payload. Returns null when the payload is not
 * a snapshot at all; individually malformed rows are dropped, since one bad
 * row must never blank the layer.
 * @returns {{rows: object[], sources: object[], stale: boolean, fetchedAt: number|null}|null}
 */
export function normalizeIncidentSnapshot(payload) {
  if (!payload || !Array.isArray(payload.rows)) return null;
  const rows = [];
  const seen = new Set();
  for (const raw of payload.rows) {
    if (!raw || typeof raw !== 'object') continue;
    const [source, ...rest] = String(raw.id || '').split(':');
    const row = incidentRecord({
      ...raw,
      id: rest.join(':'),
      source: raw.source || source,
    });
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
  }
  const sources = Array.isArray(payload.sources)
    ? payload.sources
        .filter((entry) => entry && typeof entry === 'object')
        .map((entry) => ({
          id: incidentText(entry.id, 40),
          label: incidentText(entry.label, 80),
          ok: entry.ok === true,
          count: Number.isFinite(entry.count) ? entry.count : 0,
          fetchedAt: Number.isFinite(entry.fetchedAt) ? entry.fetchedAt : null,
          refreshMs: Number.isFinite(entry.refreshMs) ? entry.refreshMs : null,
          error: incidentText(entry.error, 160),
        }))
        .filter((entry) => entry.id)
    : [];
  return {
    rows,
    sources,
    stale: payload.stale === true,
    fetchedAt: Number.isFinite(payload.fetchedAt) ? payload.fetchedAt : null,
  };
}

/** Newest first; undated rows last, then by id for a stable order. */
export function sortIncidentsNewestFirst(rows) {
  return rows
    .slice()
    .sort(
      (a, b) =>
        (b.time ?? -Infinity) - (a.time ?? -Infinity) ||
        String(a.id).localeCompare(String(b.id)),
    );
}
