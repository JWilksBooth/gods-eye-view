/**
 * Windy Webcams API v3 discovery of public webcams in each LIVE OPS region.
 *
 * `GET /webcams/api/v3/webcams?nearby=lat,lon,radius` with the
 * `x-windy-api-key` header lists webcams around a point with their
 * location, current images, player pages and provider links. Windy's
 * terms: show images only from the API's own URLs (their tokens expire in
 * 10 to 15 minutes, so an image URL is never cached beyond that), link each
 * webcam to its Windy page or player, use Windy's player for live and
 * timelapse views, and credit "Webcams provided by windy.com".
 *
 * So webcam metadata is cached per region for an hour, but an image URL is
 * served only within nine minutes of the fetch that produced it and dropped
 * afterwards; each row links out to Windy's live player. Nothing here is
 * fetched without `WINDY_WEBCAMS_API_KEY`.
 */
import {
  LIVE_OPS_REGIONS,
  regionContains,
} from '../../../src/data/liveOpsRegions.js';
import { streamRecord } from '../../../src/layers/streams/records.js';
import { fetchStreamsUpstream, regionRadiusKm } from './common.js';

export const WINDY_SOURCE = Object.freeze({
  id: 'windy',
  label: 'Windy webcams',
  keyEnv: 'WINDY_WEBCAMS_API_KEY',
  refreshMs: 5 * 60_000,
});
export const WINDY_WEBCAMS_URL = 'https://api.windy.com/webcams/api/v3/webcams';
/** Webcam metadata is refreshed once an hour per region. */
export const WINDY_REGION_CACHE_MS = 60 * 60_000;
/** Image URLs expire in 10 to 15 minutes; never serve one older than this. */
export const WINDY_IMAGE_FRESH_MS = 9 * 60_000;
/** The `nearby` radius Windy accepts, in kilometres. */
export const WINDY_MAX_RADIUS_KM = 250;
export const WINDY_LIMIT = 50;
export const WINDY_CREDIT = 'Webcams provided by windy.com';

const TERMS =
  'Webcams provided by windy.com; opens in Windy’s player, and preview images come from the Windy API and expire within minutes';

/** The webcams request for one region (the key travels in a header). */
export function windyWebcamsUrl({ region, limit = WINDY_LIMIT }) {
  const url = new URL(WINDY_WEBCAMS_URL);
  url.searchParams.set(
    'nearby',
    `${region.center.lat.toFixed(4)},${region.center.lon.toFixed(4)},${regionRadiusKm(
      region,
      { max: WINDY_MAX_RADIUS_KM },
    )}`,
  );
  url.searchParams.set('limit', String(Math.max(1, Math.min(50, limit))));
  url.searchParams.set('include', 'location,images,player,urls,categories');
  return url.toString();
}

/**
 * One API answer as rows inside the region's box, each linking to Windy's
 * live player with the API's current preview as its poster.
 * @param {object} payload
 * @param {{region: object, now: number}} context
 * @returns {object[]}
 */
export function parseWindyWebcams(payload, { region, now }) {
  const webcams = Array.isArray(payload?.webcams)
    ? payload.webcams
    : Array.isArray(payload?.result?.webcams)
      ? payload.result.webcams
      : null;
  if (!webcams) throw new Error('Windy answered no webcams');
  const rows = [];
  for (const webcam of webcams) {
    const id = webcam?.webcamId ?? webcam?.id;
    const location = webcam?.location || {};
    const lat = Number(location.latitude);
    const lon = Number(location.longitude);
    if (id == null || !regionContains(region, { lat, lon })) continue;
    if (webcam?.status && webcam.status !== 'active') continue;
    const player = webcam?.player || {};
    const urls = webcam?.urls || {};
    const row = streamRecord({
      id: String(id),
      source: WINDY_SOURCE.id,
      sourceLabel: WINDY_SOURCE.label,
      title: webcam?.title,
      lat,
      lon,
      region: region.id,
      kind: 'link',
      url: player.live || player.day || urls.detail,
      pageUrl: urls.detail || player.live,
      poster: webcam?.images?.current?.preview || webcam?.images?.current?.thumbnail,
      owner: 'windy.com',
      terms: TERMS,
      placement: 'exact',
      verifiedAt: now,
      time: webcam?.lastUpdatedOn,
      description: [location.city, location.region].filter(Boolean).join(', '),
      tags: Array.isArray(webcam?.categories)
        ? webcam.categories.map((category) => category?.name ?? category)
        : [],
    });
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * The rows as they may be served at `at`: the same metadata, with the
 * poster removed once its URL may have expired.
 */
export function presentWindyRows(rows, fetchedAt, at) {
  const fresh = Number.isFinite(fetchedAt) && at - fetchedAt <= WINDY_IMAGE_FRESH_MS;
  return fresh ? rows : rows.map((row) => ({ ...row, poster: null }));
}

/** The per-region hourly cache. Images are never persisted. */
export function createWindyDiscovery({
  now = () => Date.now(),
  warn = (...args) => console.warn(...args),
  regions = LIVE_OPS_REGIONS,
} = {}) {
  const state = new Map();

  async function load({ fetchImpl, env = process.env, now: at = now() } = {}) {
    const key = String(env[WINDY_SOURCE.keyEnv] ?? '').trim();
    if (!key) throw Object.assign(new Error('no_key'), { code: 'no_key' });
    for (const region of regions) {
      const cached = state.get(region.id);
      if (cached && at - cached.fetchedAt < WINDY_REGION_CACHE_MS) continue;
      try {
        const payload = await fetchStreamsUpstream(windyWebcamsUrl({ region }), {
          fetchImpl,
          headers: { 'x-windy-api-key': key },
        });
        state.set(region.id, {
          fetchedAt: at,
          rows: parseWindyWebcams(payload, { region, now: at }),
        });
      } catch (error) {
        warn(
          `[streams] Windy webcams for ${region.id} failed:`,
          error?.status ? `HTTP ${error.status}` : error?.message || error,
        );
      }
    }
    return [...state.values()].flatMap((entry) =>
      presentWindyRows(entry.rows, entry.fetchedAt, at),
    );
  }

  /** Strip posters that may have expired since their region was fetched. */
  function present(rows, at = now()) {
    const fetchedAt = new Map(
      [...state].map(([id, entry]) => [id, entry.fetchedAt]),
    );
    return rows.map((row) => {
      const at0 = fetchedAt.get(row.region);
      return presentWindyRows([row], at0 ?? 0, at)[0];
    });
  }

  function status() {
    return {
      regions: Object.fromEntries(
        [...state].map(([id, entry]) => [id, entry.fetchedAt]),
      ),
    };
  }

  return { load, present, status };
}
