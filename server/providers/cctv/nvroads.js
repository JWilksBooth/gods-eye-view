/**
 * Nevada 511 (nvroads.com) cameras: the Las Vegas pack.
 *
 * Nevada DOT's 511 site runs the same Iteris "511" platform as Ontario 511
 * and FL511. Two routes list its cameras:
 *
 * - The keyless table behind the site's own camera list,
 *   `GET /List/GetData/Cameras?query=<DataTables JSON>&lang=en-US`, paged
 *   100 rows at a time. Rows carry a WKT `POINT (lon lat)` and one or more
 *   `images[]` whose `imageUrl` is the site-relative still `/map/Cctv/<id>`.
 * - The developer API, `GET /api/v2/get/cameras?key=<NVROADS_API_KEY>`,
 *   throttled to ten calls a minute, which answers the Ontario-shaped array
 *   (`Id`, `Latitude`, `Longitude`, `Roadway`, `Direction`, `Views[]`).
 *
 * The pack reads the developer API when a key is configured (the catalog
 * refreshes every 15 minutes, far under the throttle) and the keyless table
 * otherwise. Both routes name the same official still endpoint, which is
 * host-pinned before a camera registers. Stills are fetched at request time
 * and never stored. RTC of Southern Nevada's FAST cameras are published
 * through this same NDOT feed; RTC runs no separate public camera API.
 */
import { CCTV_SOURCE_FETCH_TIMEOUT_MS } from './constants.js';
import {
  fallbackHeadingFromId,
  pinnedCameraUrl,
  prioritizeSources,
  toFiniteNumber,
} from './normalize.js';
import { readResponseJsonCapped } from '../common/http.js';
import { directionToHeading } from '../../../src/data/directionText.js';

export const NVROADS_ORIGIN = 'https://www.nvroads.com';
export const NVROADS_TABLE_URL = `${NVROADS_ORIGIN}/List/GetData/Cameras`;
export const NVROADS_API_URL = `${NVROADS_ORIGIN}/api/v2/get/cameras`;
export const NVROADS_IMAGE_ORIGIN = `${NVROADS_ORIGIN}/map/Cctv/`;
export const DEFAULT_NVROADS_MAX_SOURCES = 400;
/** Byte cap per catalog page or API answer (the full statewide API list is well under this). */
export const NVROADS_MAX_CATALOG_BYTES = 4 * 1024 * 1024;
/** The table serves at most 100 rows a page; 30 pages covers the statewide set. */
export const NVROADS_TABLE_PAGE_SIZE = 100;
export const NVROADS_MAX_TABLE_PAGES = 30;
/** Prioritization anchors: the Las Vegas valley first, then Reno. */
export const NVROADS_ANCHORS = [
  { lat: 36.1699, lon: -115.1398 }, // Las Vegas
  { lat: 36.0395, lon: -115.0 }, // Henderson
  { lat: 39.5296, lon: -119.8138 }, // Reno
];
/** Rough Nevada bounds; a row outside is a bad coordinate, not a camera. */
const NEVADA_BOUNDS = { south: 35, north: 42.1, west: -120.1, east: -113.9 };
/** Las Vegas valley prior in metres (the valley floor runs 500–900 m). */
const LAS_VEGAS_ELEVATION_M = 620;

/** The DataTables request the site's own camera list sends. */
export function nvroadsTableQuery(start, length = NVROADS_TABLE_PAGE_SIZE) {
  return JSON.stringify({
    columns: [
      { data: null, name: '' },
      { name: 'sortOrder', s: true },
      { name: 'region', s: true },
      { name: 'roadway', s: true },
      { data: 4, name: '' },
    ],
    order: [{ column: 1, dir: 'asc' }],
    start,
    length,
    search: { value: '' },
  });
}

function isLikelyNevadaCoordinate(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= NEVADA_BOUNDS.south &&
    lat <= NEVADA_BOUNDS.north &&
    lon >= NEVADA_BOUNDS.west &&
    lon <= NEVADA_BOUNDS.east
  );
}

/** `POINT (-115.17 36.10)` → { lat, lon }; WKT is longitude first. */
export function parseNvroadsPoint(value) {
  const match = /POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)/i.exec(
    String(value || ''),
  );
  if (!match) return { lat: NaN, lon: NaN };
  return { lon: Number(match[1]), lat: Number(match[2]) };
}

/** The official still for a camera view id, or null when the id is not plain. */
function nvroadsStillUrl(rawId) {
  const id = String(rawId ?? '').trim();
  return /^[1-9]\d{0,8}$/.test(id) ? `${NVROADS_IMAGE_ORIGIN}${id}` : null;
}

function buildCamera({
  rawId,
  lat,
  lon,
  roadway,
  direction,
  location,
  region,
  viewLabel,
  imageUrl,
}) {
  const pinned = pinnedCameraUrl(imageUrl, NVROADS_IMAGE_ORIGIN);
  if (!pinned || !isLikelyNevadaCoordinate(lat, lon)) return null;
  const cameraId = `nv-${rawId}`;
  const place = String(location || roadway || '').trim();
  const label = [place || `Nevada 511 camera ${rawId}`, viewLabel]
    .filter(Boolean)
    .join(' - ');
  let heading = directionToHeading(direction, true);
  if (!Number.isFinite(heading)) heading = directionToHeading(viewLabel, true);
  const hasHeading = Number.isFinite(heading);
  return {
    id: cameraId,
    name: label.slice(0, 160),
    city: String(region || 'Nevada').trim() || 'Nevada',
    cityId: 'nevada-511',
    provider: 'Nevada 511',
    lat,
    lon,
    headingDeg: hasHeading ? heading : fallbackHeadingFromId(cameraId),
    headingConfidence: hasHeading ? 'high' : 'low',
    // The same two pose personalities as the other packs: raw priors that
    // the client's ground snap and manual calibration refine.
    pitchDeg: hasHeading ? -24 : -18,
    fovDeg: hasHeading ? 56 : 44,
    rangeM: hasHeading ? 210 : 145,
    mountHeightM: hasHeading ? 10 : 8,
    groundElevationM: LAS_VEGAS_ELEVATION_M,
    feedType: 'image',
    url: pinned,
    snapshotUrl: pinned,
    sourceKind: 'nvroads-open-data',
    license:
      'Nevada DOT 511 public traffic camera still (nvroads.com); no licence text published',
  };
}

/** One keyless table row → a camera source, or null. */
export function nvroadsTableRowToSource(row) {
  if (!row || typeof row !== 'object') return null;
  const rawId = String(row.id ?? row.Id ?? '').trim();
  if (!/^[1-9]\d{0,8}$/.test(rawId)) return null;
  let lat = toFiniteNumber(row.latitude ?? row.Latitude);
  let lon = toFiniteNumber(row.longitude ?? row.Longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    ({ lat, lon } = parseNvroadsPoint(
      row.latLng?.geography?.wellKnownText ?? row.latLng?.wellKnownText,
    ));
  }
  const images = Array.isArray(row.images) ? row.images : [];
  const image =
    images.find(
      (entry) =>
        entry &&
        entry.disabled !== true &&
        entry.blocked !== true &&
        entry.imageUrl,
    ) || null;
  if (!image) return null;
  let imageUrl;
  try {
    imageUrl = new URL(String(image.imageUrl), NVROADS_ORIGIN).href;
  } catch {
    return null;
  }
  return buildCamera({
    rawId,
    lat,
    lon,
    roadway: row.roadway ?? row.Roadway,
    direction: row.direction ?? row.Direction,
    location: row.location ?? row.displayName ?? row.Location,
    region: row.region ?? row.city ?? row.county,
    viewLabel: String(image.description || '').trim(),
    imageUrl,
  });
}

/** One developer-API row (Ontario-shaped) → a camera source, or null. */
export function nvroadsApiRowToSource(row) {
  if (!row || typeof row !== 'object') return null;
  const rawId = String(row.Id ?? row.id ?? '').trim();
  if (!/^[1-9]\d{0,8}$/.test(rawId)) return null;
  const lat = toFiniteNumber(row.Latitude ?? row.latitude);
  const lon = toFiniteNumber(row.Longitude ?? row.longitude);
  const views = Array.isArray(row.Views ?? row.views)
    ? (row.Views ?? row.views)
    : [];
  const view =
    views.find(
      (entry) =>
        entry &&
        String(entry.Status ?? entry.status ?? 'Enabled').toLowerCase() !==
          'disabled',
    ) || null;
  if (!view) return null;
  const viewId = String(view.Id ?? view.id ?? rawId).trim();
  const imageUrl =
    pinnedCameraUrl(view.Url ?? view.url, NVROADS_IMAGE_ORIGIN) ||
    nvroadsStillUrl(viewId);
  return buildCamera({
    rawId,
    lat,
    lon,
    roadway: row.Roadway ?? row.roadway,
    direction: row.Direction ?? row.direction,
    location: row.Location ?? row.location,
    region: row.Region ?? row.region ?? row.City ?? row.city,
    viewLabel: String(view.Description ?? view.description ?? '').trim(),
    imageUrl,
  });
}

async function fetchJson(url, headers) {
  const resp = await fetch(url, {
    headers: { Accept: 'application/json', ...headers },
    redirect: 'manual',
    signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
  });
  if (resp.status >= 300 && resp.status < 400) {
    try {
      await resp.body?.cancel();
    } catch {
      /* no-op */
    }
    throw new Error('redirected; redirects are not followed');
  }
  if (!resp.ok) {
    try {
      await resp.body?.cancel();
    } catch {
      /* no-op */
    }
    throw new Error(`HTTP ${resp.status}`);
  }
  return readResponseJsonCapped(resp, NVROADS_MAX_CATALOG_BYTES);
}

async function loadFromApi(key) {
  const url = new URL(NVROADS_API_URL);
  url.searchParams.set('key', key);
  url.searchParams.set('format', 'json');
  const rows = await fetchJson(url);
  if (!Array.isArray(rows)) throw new Error('developer API answered no list');
  return rows.map(nvroadsApiRowToSource).filter(Boolean);
}

async function loadFromTable() {
  const cameras = [];
  for (let page = 0; page < NVROADS_MAX_TABLE_PAGES; page += 1) {
    const url = new URL(NVROADS_TABLE_URL);
    url.searchParams.set(
      'query',
      nvroadsTableQuery(page * NVROADS_TABLE_PAGE_SIZE),
    );
    url.searchParams.set('lang', 'en-US');
    const body = await fetchJson(url, { 'X-Requested-With': 'XMLHttpRequest' });
    const rows = Array.isArray(body?.data) ? body.data : [];
    for (const row of rows) {
      const camera = nvroadsTableRowToSource(row);
      if (camera) cameras.push(camera);
    }
    const total = toFiniteNumber(body?.recordsFiltered ?? body?.recordsTotal);
    if (
      rows.length < NVROADS_TABLE_PAGE_SIZE ||
      (Number.isFinite(total) && (page + 1) * NVROADS_TABLE_PAGE_SIZE >= total)
    )
      break;
  }
  return cameras;
}

/**
 * Load the Nevada 511 cameras: the developer API with `NVROADS_API_KEY`,
 * the keyless site table without. Fails soft to an empty pack.
 */
export async function loadNvroadsSources(_options = {}, env = process.env) {
  const key = String(env.NVROADS_API_KEY ?? '').trim();
  try {
    let cameras;
    try {
      cameras = key ? await loadFromApi(key) : await loadFromTable();
    } catch (error) {
      if (!key) throw error;
      console.warn(
        '[CCTV] Nevada 511 developer API failed, using the site camera table:',
        error?.message || error,
      );
      cameras = await loadFromTable();
    }
    const unique = Array.from(
      new Map(cameras.map((camera) => [camera.id, camera])).values(),
    );
    const maxRaw = Number(
      env.CCTV_NVROADS_MAX_SOURCES || DEFAULT_NVROADS_MAX_SOURCES,
    );
    const maxCount = Number.isFinite(maxRaw)
      ? Math.max(8, Math.min(1500, Math.floor(maxRaw)))
      : DEFAULT_NVROADS_MAX_SOURCES;
    const prioritized = prioritizeSources(unique, maxCount, NVROADS_ANCHORS);
    console.log(
      `[CCTV] Loaded Nevada 511 camera sources: ${unique.length} published (using nearest ${prioritized.length})`,
    );
    return prioritized;
  } catch (error) {
    console.warn(
      '[CCTV] Nevada 511 camera download error:',
      error?.message || error,
    );
    return [];
  }
}
