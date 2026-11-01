/**
 * US EPA AirNow observations for the regions, through the AirNow API's
 * bounding-box query (a free key from docs.airnowapi.org; 500 requests an
 * hour per key). One request per region box per refresh, every fifteen
 * minutes, is sixteen requests an hour. Without AIRNOW_API_KEY the feed
 * reports `key-required` and upstream is never touched; the key is a query
 * parameter, so no request address ever reaches a log line or an error.
 *
 * Every site's newest reading is served at `/api/alerts/airnow`; a site at
 * "Unhealthy for Sensitive Groups" or worse also becomes an `air` alert.
 */
import { createAlert } from '../../../src/layers/alerts/model.js';
import {
  ALERT_REGIONS,
  bboxContains,
} from '../../../src/layers/alerts/regions.js';
import { ALERT_FEEDS } from './feeds.js';
import { UpstreamError, fetchUpstreamText, parseJsonText } from './http.js';

export const AIRNOW_DATA_URL = 'https://www.airnowapi.org/aq/data/';
export const AIRNOW_PARAMETERS = 'OZONE,PM25,PM10';
const MAX_BYTES = 4 * 1024 * 1024;

/** AirNow AQI categories 1–6, with the alert severity from category 3 up. */
export const AIRNOW_CATEGORIES = Object.freeze({
  1: Object.freeze({ name: 'Good', severity: null }),
  2: Object.freeze({ name: 'Moderate', severity: null }),
  3: Object.freeze({
    name: 'Unhealthy for Sensitive Groups',
    severity: 'moderate',
  }),
  4: Object.freeze({ name: 'Unhealthy', severity: 'severe' }),
  5: Object.freeze({ name: 'Very Unhealthy', severity: 'extreme' }),
  6: Object.freeze({ name: 'Hazardous', severity: 'extreme' }),
});

/** The AQI category number for an AQI value (the EPA breakpoints). */
export function aqiCategory(aqi) {
  if (!Number.isFinite(aqi) || aqi < 0) return null;
  if (aqi <= 50) return 1;
  if (aqi <= 100) return 2;
  if (aqi <= 150) return 3;
  if (aqi <= 200) return 4;
  if (aqi <= 300) return 5;
  return 6;
}

/** `YYYY-MM-DDTHH` in UTC, the hour format the AirNow data service takes. */
export function airNowHour(ms) {
  return new Date(ms).toISOString().slice(0, 13);
}

/** The data-service address for one region box; the key is a query parameter. */
export function airNowRegionUrl(region, key, now = Date.now()) {
  const [west, south, east, north] = region.bbox;
  return `${AIRNOW_DATA_URL}?${new URLSearchParams({
    startDate: airNowHour(now - 2 * 60 * 60_000),
    endDate: airNowHour(now),
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
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * Collapse AirNow rows (one per site, hour and pollutant) into one reading
 * per site: the newest hour, and the pollutant with the highest AQI, which is
 * how AirNow itself reports a site. Rows without coordinates or an AQI are
 * skipped. Null when the payload is not a row list.
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
    // `YYYY-MM-DDTHH:MM` in UTC; Date.parse alone accepts far looser text.
    const hour = String(row.UTC || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(hour)) continue;
    const observedMs = Date.parse(`${hour}:00Z`);
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
    const category = number(row.Category) ?? aqiCategory(aqi);
    bySite.set(code, {
      id: `airnow:${code}`,
      provider: 'airnow',
      lat,
      lon,
      aqi,
      category,
      categoryName: AIRNOW_CATEGORIES[category]?.name ?? null,
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

/** An `air` alert for a reading at category 3 or worse, else null. */
export function airNowAlert(reading, { fetchedAt = Date.now() } = {}) {
  const category = AIRNOW_CATEGORIES[reading?.category];
  if (!category?.severity) return null;
  const pollutant = reading.parameter ? ` (${reading.parameter})` : '';
  return createAlert(
    {
      id: reading.id,
      source: 'airnow',
      kind: 'air',
      severity: category.severity,
      agency: reading.agency || 'US EPA AirNow',
      headline: `AQI ${Math.round(reading.aqi)} · ${category.name}${pollutant}`,
      body: `Hourly AQI observed at ${reading.site}. AirNow data are preliminary and not fully verified.`,
      area: { type: 'Point', coordinates: [reading.lon, reading.lat] },
      areaSource: 'site',
      areaDescription: reading.site,
      regions: [reading.region],
      starts: reading.observedAt,
      ends: null,
      issued: reading.observedAt,
      updated: reading.observedAt,
      url: 'https://www.airnow.gov/',
    },
    { fetchedAt },
  );
}

/**
 * The AirNow feed as the proxy loads it: every site's newest reading in the
 * region boxes and the alerts among them. The key is read on every load,
 * so one saved in Provider Settings applies without a restart; while it is
 * absent `keyMissing()` is true and the feed is never requested.
 */
export function createAirNowFeedSource({
  fetchImpl,
  now = () => Date.now(),
  env = {},
  regions = ALERT_REGIONS,
} = {}) {
  const feed = ALERT_FEEDS.airnow;
  const apiKey = () => String(env[feed.envVar] || '').trim();
  return {
    ...feed,
    keyMissing: () => !apiKey(),
    async load() {
      const key = apiKey();
      if (!key) throw new UpstreamError('no_key');
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
          if (!rows) throw new UpstreamError('invalid_payload');
          loaded += 1;
          // The box query is exact; a site outside it is not this region's.
          readings.push(
            ...rows.filter((row) =>
              bboxContains(region.bbox, row.lon, row.lat),
            ),
          );
        } catch (error) {
          lastError = error;
        }
      }
      if (!loaded) throw lastError || new UpstreamError('unavailable');
      const fetchedAt = now();
      return {
        readings,
        alerts: readings
          .map((reading) => airNowAlert(reading, { fetchedAt }))
          .filter(Boolean),
        fetchedAt,
        partial: loaded < regions.length,
      };
    },
  };
}
