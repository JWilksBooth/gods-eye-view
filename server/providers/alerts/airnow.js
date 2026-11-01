/**
 * US EPA AirNow observations for the regions, through the AirNow API's
 * bounding-box query (a free key from docs.airnowapi.org, 500 requests an
 * hour). Serves `/api/air-quality/airnow`; without AIRNOW_API_KEY it answers
 * 503 `no_key`, as the FIRMS proxy does, and upstream is never touched.
 * Four bounding boxes per refresh, every fifteen minutes, is sixteen requests
 * an hour. The key never appears in a log line or an error.
 */
import { ALERT_REGIONS } from '../../../src/layers/alerts/regions.js';
import { makeRateLimiter, clientKey } from '../common/rate-limit.js';
import { createFeedGovernor } from './governor.js';
import { fetchUpstreamText, parseJsonText } from './http.js';

export const AIRNOW_DATA_URL = 'https://www.airnowapi.org/aq/data/';
export const AIRNOW_PARAMETERS = 'OZONE,PM25,PM10';
export const AIRNOW_REFRESH_MS = 15 * 60_000;
const MAX_BYTES = 4 * 1024 * 1024;

/** `YYYY-MM-DDTHH` in UTC, the hour format the AirNow data service takes. */
export function airNowHour(ms) {
  return new Date(ms).toISOString().slice(0, 13);
}

/** The data-service address for one region box; the key is a query parameter. */
export function airNowRegionUrl(region, key, now = Date.now()) {
  const [west, south, east, north] = region.bbox;
  const end = now;
  const start = now - 2 * 60 * 60_000;
  return `${AIRNOW_DATA_URL}?${new URLSearchParams({
    startDate: airNowHour(start),
    endDate: airNowHour(end),
    parameters: AIRNOW_PARAMETERS,
    BBOX: `${west},${south},${east},${north}`,
    dataType: 'A',
    format: 'application/json',
    verbose: '1',
    monitorType: '0',
    includerawconcentrations: '0',
    API_KEY: key,
  })}`;
}

const number = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * Collapse AirNow rows (one per site, hour and pollutant) into one reading
 * per site: the newest hour, and the pollutant with the highest AQI, which is
 * how AirNow itself reports a site. Rows without coordinates or an AQI are
 * skipped; `Category` is AirNow's 1–6 category number.
 */
export function normalizeAirNowRows(rows, regionId) {
  if (!Array.isArray(rows)) return null;
  const bySite = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const lat = number(row.Latitude);
    const lon = number(row.Longitude);
    const aqi = number(row.AQI);
    if (lat === null || lon === null || aqi === null || aqi < 0) continue;
    const observedMs = Date.parse(`${String(row.UTC || '').trim()}:00Z`);
    if (!Number.isFinite(observedMs)) continue;
    const code =
      String(row.FullAQSCode || row.IntlAQSCode || '').trim() ||
      `${lat.toFixed(4)},${lon.toFixed(4)}`;
    const existing = bySite.get(code);
    if (
      existing &&
      (existing.observedMs > observedMs ||
        (existing.observedMs === observedMs && existing.aqi >= aqi))
    )
      continue;
    bySite.set(code, {
      id: `airnow:${code}`,
      provider: 'airnow',
      lat,
      lon,
      aqi,
      category: number(row.Category),
      parameter: String(row.Parameter || '').trim() || null,
      site: String(row.SiteName || '').trim() || code,
      agency: String(row.AgencyName || '').trim() || null,
      observedMs,
      observedAt: new Date(observedMs).toISOString(),
      region: regionId,
    });
  }
  return [...bySite.values()];
}

/** The AirNow proxy: fixed region boxes, one governor, no client destinations. */
export function airNowProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  env = process.env,
  regions = ALERT_REGIONS,
} = {}) {
  const governor = createFeedGovernor({
    id: 'airnow',
    ttlMs: AIRNOW_REFRESH_MS,
    staleMaxMs: 3 * 60 * 60_000,
    budgetPerHour: 40,
    now,
  });
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 600 });
  const apiKey = () => String(env.AIRNOW_API_KEY || '').trim();

  async function load() {
    const key = apiKey();
    const readings = [];
    let loaded = 0;
    let lastError = null;
    for (const region of regions) {
      try {
        const { payload } = await fetchUpstreamText(
          airNowRegionUrl(region, key, now()),
          {
            fetchImpl,
            headers: { Accept: 'application/json' },
            timeoutMs: 20_000,
            maxBytes: MAX_BYTES,
          },
        );
        const rows = normalizeAirNowRows(parseJsonText(payload), region.id);
        if (!rows) throw new Error('airnow_invalid_payload');
        loaded += 1;
        readings.push(...rows);
      } catch (error) {
        // Never surface the request URL: it carries the key.
        lastError = new Error(
          error?.status ? `AirNow HTTP ${error.status}` : 'AirNow request failed',
        );
      }
    }
    if (!loaded) throw lastError || new Error('AirNow request failed');
    return { readings, partial: loaded < regions.length };
  }

  async function handler(req, res) {
    const json = (status, value, extra = {}) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...extra,
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET')
      return json(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
    const path = (req.url || '/').split('?')[0];
    if (path !== '/' && path !== '')
      return json(404, { error: 'unknown_route' });
    if (!apiKey())
      return json(503, { error: 'no_key', provider: 'airnow' });
    if (!allow(clientKey(req)))
      return json(429, { error: 'rate_limited' }, { 'Retry-After': '30' });
    try {
      const { value, fetchedAt, stale, status } = await governor.acquire(load);
      json(200, {
        provider: 'airnow',
        fetchedAt: new Date(fetchedAt).toISOString(),
        stale,
        status,
        partial: value.partial === true,
        readings: value.readings,
      }, stale ? { 'X-Data-Stale': 'true' } : {});
    } catch (error) {
      json(502, { error: 'airnow_unavailable', provider: 'airnow' });
    }
  }

  return {
    name: 'air-quality-airnow',
    configureServer({ middlewares }) {
      middlewares.use('/api/air-quality/airnow', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/air-quality/airnow', handler);
    },
  };
}
