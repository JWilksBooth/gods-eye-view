/**
 * CAL FIRE active incidents from the public incidents API on fire.ca.gov
 * (keyless; California public record). The GeoJSON list is preferred; the
 * plain list and the older host are tried when it is unavailable, and the
 * address that answered is remembered for the next refresh.
 */
import { clampText, createAlert } from '../../../src/layers/alerts/model.js';
import { regionsForPoint } from '../../../src/layers/alerts/regions.js';
import { ALERT_FEEDS } from './feeds.js';
import { UpstreamError, fetchUpstreamText, parseJsonText } from './http.js';

export const CALFIRE_INCIDENT_URLS = Object.freeze([
  'https://incidents.fire.ca.gov/umbraco/api/IncidentApi/GeoJsonList?inactive=false',
  'https://www.fire.ca.gov/umbraco/api/IncidentApi/GeoJsonList?inactive=false',
  'https://incidents.fire.ca.gov/umbraco/api/IncidentApi/List?inactive=false',
  'https://www.fire.ca.gov/umbraco/api/IncidentApi/List?inactive=false',
]);
const CALFIRE_HOME = 'https://www.fire.ca.gov/';
const MAX_BYTES = 8 * 1024 * 1024;

/** A property by name, accepting the lowercase-first spelling too. */
function field(row, name) {
  if (!row || typeof row !== 'object') return undefined;
  if (row[name] !== undefined && row[name] !== null && row[name] !== '')
    return row[name];
  const lower = name[0].toLowerCase() + name.slice(1);
  if (row[lower] !== undefined && row[lower] !== null && row[lower] !== '')
    return row[lower];
  return undefined;
}

const number = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** Severity from size and containment, so a contained fire reads calmer. */
export function calFireSeverity(acres, containedPct) {
  const size = Number.isFinite(acres) ? acres : 0;
  const pct = Number.isFinite(containedPct) ? containedPct : 0;
  if (pct >= 100) return 'minor';
  if (size >= 50_000 && pct < 50) return 'extreme';
  if (size >= 5000 || (size >= 1000 && pct < 25)) return 'severe';
  if (size >= 300 || pct < 25) return 'moderate';
  return 'minor';
}

/** The rows of a GeoJSON list or a plain list payload. */
export function calFireRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.features))
    return payload.features.map((feature) => ({
      ...(feature?.properties || {}),
      __geometry: feature?.geometry || null,
    }));
  return null;
}

/** Normalize one incident row to an alert, or null when it cannot be placed. */
export function normalizeCalFireIncident(row, { fetchedAt = Date.now() } = {}) {
  if (!row || typeof row !== 'object') return null;
  const active = field(row, 'IsActive');
  if (active === false || String(active).toLowerCase() === 'false') return null;
  const name = clampText(field(row, 'Name'), 160);
  if (!name) return null;
  const coordinates = Array.isArray(row.__geometry?.coordinates)
    ? row.__geometry.coordinates
    : [field(row, 'Longitude'), field(row, 'Latitude')];
  const lon = number(coordinates?.[0]);
  const lat = number(coordinates?.[1]);
  if (lon === null || lat === null) return null;
  const regions = regionsForPoint(lon, lat);
  if (!regions.length) return null;
  const acres = number(field(row, 'AcresBurned'));
  const contained = number(field(row, 'PercentContained'));
  const type = clampText(field(row, 'Type'), 60);
  const location = clampText(field(row, 'Location'), 200);
  const county = clampText(field(row, 'County') ?? field(row, 'Counties'), 80);
  const facts = [
    acres !== null ? `${Math.round(acres).toLocaleString('en-US')} acres` : null,
    contained !== null ? `${Math.round(contained)}% contained` : null,
    clampText(field(row, 'ControlStatement'), 300),
  ].filter(Boolean);
  let url = null;
  const rawUrl = field(row, 'Url');
  if (typeof rawUrl === 'string' && rawUrl.trim()) {
    try {
      url = new URL(rawUrl.trim(), CALFIRE_HOME).href;
    } catch {
      url = null;
    }
  }
  const uniqueId = clampText(field(row, 'UniqueId'), 120) || name;
  return createAlert(
    {
      id: `calfire:${uniqueId}`,
      source: 'calfire',
      kind: 'fire',
      severity: calFireSeverity(acres, contained),
      agency: clampText(field(row, 'AdminUnit'), 120) || 'CAL FIRE',
      headline: type && !/wildfire/i.test(type) ? `${name} · ${type}` : name,
      body: facts.join(' · ') || null,
      area: { type: 'Point', coordinates: [lon, lat] },
      areaSource: 'feed',
      areaDescription: [location, county ? `${county} County` : null]
        .filter(Boolean)
        .join(', '),
      regions,
      starts: field(row, 'Started'),
      ends: field(row, 'ExtinguishedDate'),
      issued: field(row, 'Updated') ?? field(row, 'Started'),
      updated: field(row, 'Updated'),
      url: url || `${CALFIRE_HOME}incidents`,
    },
    { fetchedAt },
  );
}

/** The CAL FIRE feed as the proxy loads it: active incidents in the regions. */
export function createCalFireFeedSource({
  fetchImpl,
  now = () => Date.now(),
  urls = CALFIRE_INCIDENT_URLS,
} = {}) {
  let preferred = 0;
  return {
    ...ALERT_FEEDS.calfire,
    async load() {
      let lastError = null;
      for (let attempt = 0; attempt < urls.length; attempt += 1) {
        const index = (preferred + attempt) % urls.length;
        try {
          const { payload } = await fetchUpstreamText(urls[index], {
            fetchImpl,
            headers: { Accept: 'application/json' },
            timeoutMs: 20_000,
            maxBytes: MAX_BYTES,
          });
          const rows = calFireRows(parseJsonText(payload));
          if (!rows) throw new UpstreamError('calfire_invalid_payload');
          preferred = index;
          const fetchedAt = now();
          const alerts = [];
          const seen = new Set();
          for (const row of rows) {
            const alert = normalizeCalFireIncident(row, { fetchedAt });
            if (alert && !seen.has(alert.id)) {
              seen.add(alert.id);
              alerts.push(alert);
            }
          }
          return { alerts, fetchedAt };
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError || new UpstreamError('calfire_unavailable');
    },
  };
}
