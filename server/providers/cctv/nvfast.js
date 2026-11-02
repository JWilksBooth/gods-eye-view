/**
 * RTC FAST Dashboard cameras: the Las Vegas valley pack.
 *
 * The Regional Transportation Commission of Southern Nevada runs FAST (the
 * Freeway and Arterial System of Transportation), which operates the
 * valley's traffic cameras for NDOT, Clark County and the cities of Las
 * Vegas, Henderson and North Las Vegas. Its public "FAST Dashboard"
 * (bugatti.nvfast.org) lists every camera on one page, `CCTVs.aspx`, as a
 * JSON table embedded in the page's script
 * (`{"TempTable":[[id,"name",lat,lon,"snapshot",hlsUrl|null], …]}`, about
 * 1,250 rows, 1,150 of them inside the Las Vegas LIVE OPS box on
 * 2026-11-02), and serves each camera's current still at
 * `Snapshots/<id>.jpeg`. About a quarter of the rows also name an NDOT HLS
 * playlist on `d1wse<n>.its.nv.gov`.
 *
 * Nevada 511 (nvroads.js) publishes roughly a third of these cameras; the
 * catalog drops a Nevada 511 camera that sits on the same pole as a FAST one
 * (cap.js, suppressPackOverlaps), so the valley lists each camera once.
 *
 * The dashboard publishes no licence text; its About page says it exists so
 * "the public" can get "basic travel time related information and camera
 * snapshots". Stills are fetched at request time and never stored, with
 * attribution to RTC of Southern Nevada FAST (src/data/dataCredits.js).
 */
import { CCTV_SOURCE_FETCH_TIMEOUT_MS } from './constants.js';
import {
  fallbackHeadingFromId,
  pinnedCameraUrl,
  prioritizeSources,
  toFiniteNumber,
} from './normalize.js';
import { readCappedResponseText } from '../common/http.js';
import { directionToHeading } from '../../../src/data/directionText.js';

export const NVFAST_ORIGIN = 'https://bugatti.nvfast.org';
export const NVFAST_CATALOG_URL = `${NVFAST_ORIGIN}/CCTVs.aspx`;
export const NVFAST_IMAGE_ORIGIN = `${NVFAST_ORIGIN}/Snapshots/`;
export const DEFAULT_NVFAST_MAX_SOURCES = 1200;
/** The catalog page is about 680 KB. */
export const NVFAST_MAX_CATALOG_BYTES = 6 * 1024 * 1024;
/** Prioritization anchors: the Las Vegas valley. */
export const NVFAST_ANCHORS = [
  { lat: 36.1699, lon: -115.1398 }, // Las Vegas
  { lat: 36.0395, lon: -115.0 }, // Henderson
  { lat: 36.1989, lon: -115.1175 }, // North Las Vegas
];
/** Clark County; a row outside is a bad coordinate, not a camera. */
const CLARK_COUNTY_BOUNDS = {
  south: 35.0,
  north: 36.9,
  west: -115.9,
  east: -114.0,
};
/** The Las Vegas LIVE OPS box (src/data/liveOpsRegions.js), for the city label. */
const LAS_VEGAS_BOX = {
  west: -115.45,
  south: 35.9,
  east: -114.85,
  north: 36.4,
};
/** Las Vegas valley prior in metres (the valley floor runs 500–900 m). */
const LAS_VEGAS_ELEVATION_M = 620;

/**
 * Accept an NDOT live-stream URL only on NDOT's own Wowza hosts, over HTTPS,
 * as a bare `/<app>/<camera>_public.stream/playlist.m3u8` path: no
 * credentials, no query, nothing that could steer the HLS proxy elsewhere.
 * @param {unknown} value The row's playlist URL.
 * @returns {string|null}
 */
export function nvfastStreamUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    !/^d1wse\d{1,2}\.its\.nv\.gov$/.test(url.hostname) ||
    (url.port && url.port !== '443') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.stream\/playlist\.m3u8$/.test(
      url.pathname,
    )
  )
    return null;
  return url.href;
}

/** The dashboard's still for a camera id, host-pinned. */
export function nvfastStillUrl(rawId) {
  const id = String(rawId ?? '').trim();
  if (!/^[1-9]\d{0,8}$/.test(id)) return null;
  return pinnedCameraUrl(
    `${NVFAST_IMAGE_ORIGIN}${id}.jpeg`,
    NVFAST_IMAGE_ORIGIN,
  );
}

function inside(box, lat, lon) {
  return (
    lat >= box.south && lat <= box.north && lon >= box.west && lon <= box.east
  );
}

/**
 * The camera table embedded in the dashboard page: the JSON array after
 * `"TempTable":`. Throws when the page carries no table.
 * @param {string} html
 * @returns {Array<Array<unknown>>}
 */
export function parseNvfastCatalogPage(html) {
  const text = String(html ?? '');
  const start = text.indexOf('"TempTable"');
  if (start < 0) throw new Error('no camera table in the dashboard page');
  const open = text.indexOf('[', start);
  if (open < 0) throw new Error('no camera table in the dashboard page');
  // The table is a JSON array literal; walk the brackets so a stray "]" in a
  // camera name cannot cut it short. Strings may hold escaped quotes.
  let depth = 0;
  let inString = false;
  let end = -1;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) throw new Error('unterminated camera table');
  const rows = JSON.parse(text.slice(open, end));
  if (!Array.isArray(rows)) throw new Error('camera table is not a list');
  return rows;
}

/**
 * One table row → a camera source, or null when the id or position is not
 * usable. Video is kept only when `video` is true and the row names an NDOT
 * playlist; the still is always the snapshot.
 * @param {Array<unknown>} row `[id, name, lat, lon, kind, hlsUrl|null]`.
 * @param {{video?: boolean}} [options]
 */
export function nvfastRowToSource(row, { video = true } = {}) {
  if (!Array.isArray(row)) return null;
  const rawId = String(row[0] ?? '').trim();
  const imageUrl = nvfastStillUrl(rawId);
  if (!imageUrl) return null;
  const lat = toFiniteNumber(row[2]);
  const lon = toFiniteNumber(row[3]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (!inside(CLARK_COUNTY_BOUNDS, lat, lon)) return null;
  const cameraId = `nvfast-${rawId}`;
  let name = String(row[1] ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  // Some rows repeat the id in front of the name ("107 I-15 NB Charleston On").
  if (name.startsWith(`${rawId} `)) name = name.slice(rawId.length + 1).trim();
  if (!name) name = `FAST camera ${rawId}`;
  const streamUrl = video ? nvfastStreamUrl(row[5]) : null;
  // "I-15 NB Charleston": the carriageway the camera watches, inferred from
  // the name, so medium confidence; an unnamed direction gets the hash prior.
  const heading = directionToHeading(name);
  const hasHeading = Number.isFinite(heading);
  return {
    id: cameraId,
    name: name.slice(0, 160),
    city: inside(LAS_VEGAS_BOX, lat, lon) ? 'Las Vegas' : 'Clark County',
    cityId: 'nvfast',
    provider: 'RTC of Southern Nevada FAST',
    lat,
    lon,
    headingDeg: hasHeading ? heading : fallbackHeadingFromId(cameraId),
    headingConfidence: hasHeading ? 'medium' : 'low',
    // The same two pose personalities as the other packs: raw priors that
    // the client's ground snap and manual calibration refine.
    pitchDeg: hasHeading ? -24 : -18,
    fovDeg: hasHeading ? 56 : 44,
    rangeM: hasHeading ? 210 : 145,
    mountHeightM: hasHeading ? 10 : 8,
    groundElevationM: LAS_VEGAS_ELEVATION_M,
    feedType: streamUrl ? 'hls' : 'image',
    url: streamUrl || imageUrl,
    snapshotUrl: imageUrl,
    sourceKind: 'nvfast-dashboard',
    license:
      'RTC of Southern Nevada FAST Dashboard public camera snapshot (bugatti.nvfast.org); no licence text published',
  };
}

/**
 * Load the FAST cameras: one page request, nearest the valley first, capped
 * by CCTV_NVFAST_MAX_SOURCES. Stills only unless CCTV_NVFAST_VIDEO=1: every
 * one of thirteen NDOT playlists sampled on 2026-11-02 answered 404, so a
 * camera registered as live would show a placeholder where its still works.
 * Fails soft to an empty pack.
 */
export async function loadNvfastSources(_options = {}, env = process.env) {
  const url = String(env.CCTV_NVFAST_URL || '').trim() || NVFAST_CATALOG_URL;
  const video = String(env.CCTV_NVFAST_VIDEO ?? '').trim() === '1';
  try {
    const resp = await fetch(url, {
      headers: {
        Accept: 'text/html',
        'User-Agent': 'osiris-cctv-proxy/1.0',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      try {
        await resp.body?.cancel();
      } catch {
        /* no-op */
      }
      throw new Error(
        resp.status >= 300 && resp.status < 400
          ? 'redirected; redirects are not followed'
          : `HTTP ${resp.status}`,
      );
    }
    const page = await readCappedResponseText(resp, NVFAST_MAX_CATALOG_BYTES);
    if (page?.tooLarge) throw new Error('dashboard page exceeds the size cap');
    const rows = parseNvfastCatalogPage(
      typeof page === 'string' ? page : page?.text,
    );
    const byId = new Map();
    for (const row of rows) {
      const camera = nvfastRowToSource(row, { video });
      if (camera && !byId.has(camera.id)) byId.set(camera.id, camera);
    }
    const cameras = [...byId.values()];
    const maxRaw = Number(
      env.CCTV_NVFAST_MAX_SOURCES || DEFAULT_NVFAST_MAX_SOURCES,
    );
    const maxCount = Number.isFinite(maxRaw)
      ? Math.max(8, Math.min(1500, Math.floor(maxRaw)))
      : DEFAULT_NVFAST_MAX_SOURCES;
    const prioritized = prioritizeSources(cameras, maxCount, NVFAST_ANCHORS);
    const live = prioritized.filter(
      (camera) => camera.feedType === 'hls',
    ).length;
    console.log(
      `[CCTV] Loaded RTC FAST camera sources: ${cameras.length} published (using nearest ${prioritized.length}, ${live} with NDOT video)`,
    );
    return prioritized;
  } catch (error) {
    console.warn(
      '[CCTV] RTC FAST camera download error:',
      error?.message || error,
    );
    return [];
  }
}
