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
 * playlist on `d1wse<n>.its.nv.gov`; whether those play depends on the day
 * (every one sampled on 2026-11-02 answered 404), so each catalog load asks
 * a few of them and registers video only when NDOT answers
 * (resolveNvfastVideo).
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
/**
 * The NDOT video probe, when CCTV_NVFAST_VIDEO is unset: up to this many of
 * the playlists the table names, spread across NDOT's `d1wse<n>` hosts, this
 * many in flight, this long each. It runs once per catalog load (every 15
 * minutes), never per request or per frame.
 */
export const NVFAST_PROBE_MAX_PLAYLISTS = 6;
export const NVFAST_PROBE_CONCURRENCY = 3;
export const NVFAST_PROBE_TIMEOUT_MS = 5000;
/** A playlist is a few hundred bytes; the probe reads no more than this. */
export const NVFAST_PROBE_MAX_BYTES = 64 * 1024;
/** The pack's own identity on every request, catalog page and probe alike. */
const NVFAST_USER_AGENT = 'osiris-cctv-proxy/1.0';
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
 * The playlists to probe: at most `max` of the distinct NDOT playlists the
 * rows name, shared round-robin across the `d1wse<n>` hosts and spaced
 * through each host's list, so one dark host or corridor does not decide
 * the pack. Hosts alternate in the result, so the requests in flight at any
 * moment spread across them too. Deterministic, so a load is reproducible.
 * @param {Array<Array<unknown>>} rows The table rows.
 * @param {number} [max]
 * @returns {string[]}
 */
export function sampleNvfastPlaylists(rows, max = NVFAST_PROBE_MAX_PLAYLISTS) {
  const byHost = new Map();
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const url = Array.isArray(row) ? nvfastStreamUrl(row[5]) : null;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const host = new URL(url).hostname;
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(url);
  }
  const hosts = [...byHost.keys()].sort();
  const shares = new Map(hosts.map((host) => [host, 0]));
  let wanted = Math.min(Math.max(0, Math.floor(max)) || 0, seen.size);
  // One per host per round until the sample is full; a host with fewer
  // playlists than rounds leaves its turn to the others.
  for (let i = 0; wanted > 0; i = (i + 1) % hosts.length) {
    const host = hosts[i];
    if (shares.get(host) < byHost.get(host).length) {
      shares.set(host, shares.get(host) + 1);
      wanted -= 1;
    }
  }
  const picks = [];
  const rounds = Math.max(0, ...shares.values());
  for (let round = 0; round < rounds; round += 1) {
    for (const host of hosts) {
      const share = shares.get(host);
      if (round >= share) continue;
      const list = byHost.get(host);
      picks.push(list[Math.floor((round * list.length) / share)]);
    }
  }
  return picks;
}

/**
 * One playlist: does NDOT answer it? `answered` is a 200 whose body starts
 * `#EXTM3U`, fetched as the pack fetches everything (its User-Agent, no
 * redirects, a byte cap, a deadline); `refused` is a 403 or 429; anything
 * else, a timeout or a network error included, is `silent`. Never throws.
 * @param {string} url
 * @param {{timeoutMs: number, fetchImpl: typeof fetch}} options
 * @returns {Promise<{outcome: 'answered'|'refused'|'silent', status: number|null}>}
 */
async function probeNvfastPlaylist(url, { timeoutMs, fetchImpl }) {
  let resp;
  try {
    resp = await fetchImpl(url, {
      headers: {
        Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, */*',
        'User-Agent': NVFAST_USER_AGENT,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { outcome: 'silent', status: null };
  }
  const status = Number(resp?.status) || 0;
  try {
    if (status === 403 || status === 429) return { outcome: 'refused', status };
    if (status !== 200) return { outcome: 'silent', status };
    const body = await readCappedResponseText(resp, NVFAST_PROBE_MAX_BYTES);
    const text = body.tooLarge ? '' : body.text.replace(/^﻿/, '').trimStart();
    return {
      outcome: text.startsWith('#EXTM3U') ? 'answered' : 'silent',
      status,
    };
  } catch {
    return { outcome: 'silent', status };
  } finally {
    if (status !== 200) {
      try {
        await resp?.body?.cancel();
      } catch {
        /* no-op */
      }
    }
  }
}

/**
 * Ask the sampled playlists, `concurrency` at a time, and count the answers.
 * A refusal (403 or 429) ends the probe, so a host that refuses us hears
 * nothing more this load; `refused` is that status, or null. Never throws.
 * @param {string[]} playlists
 * @param {{concurrency?: number, timeoutMs?: number, fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<{answered: number, probed: number, refused: number|null}>}
 */
export async function probeNvfastVideo(
  playlists,
  {
    concurrency = NVFAST_PROBE_CONCURRENCY,
    timeoutMs = NVFAST_PROBE_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
  } = {},
) {
  const queue = Array.isArray(playlists) ? [...playlists] : [];
  const result = { answered: 0, probed: 0, refused: null };
  const worker = async () => {
    while (queue.length && result.refused === null) {
      const url = queue.shift();
      result.probed += 1;
      const { outcome, status } = await probeNvfastPlaylist(url, {
        timeoutMs,
        fetchImpl,
      });
      if (outcome === 'answered') result.answered += 1;
      else if (outcome === 'refused' && result.refused === null)
        result.refused = status;
    }
  };
  const workers = Math.min(
    Math.max(1, Math.floor(concurrency) || 1),
    queue.length,
  );
  await Promise.all(Array.from({ length: workers }, worker));
  return result;
}

/**
 * Whether this load registers NDOT video, and why (for the load log line).
 * `CCTV_NVFAST_VIDEO=1` forces video and `0` forces stills without a
 * request; unset, the probe decides: video when at least one sampled
 * playlist answers, stills when none does, when no row names a playlist, or
 * when the probe itself fails. Once per catalog load, never per request.
 * @param {Array<Array<unknown>>} rows The table rows.
 * @param {Record<string, string|undefined>} [env]
 * @param {object} [probe] probeNvfastVideo options (tests shorten the deadline).
 * @returns {Promise<{video: boolean, note: string}>}
 */
export async function resolveNvfastVideo(rows, env = process.env, probe = {}) {
  const setting = String(env?.CCTV_NVFAST_VIDEO ?? '').trim();
  if (setting === '1') {
    return {
      video: true,
      note: 'CCTV_NVFAST_VIDEO=1, registering NDOT video unprobed',
    };
  }
  if (setting === '0') {
    return { video: false, note: 'CCTV_NVFAST_VIDEO=0, registering stills' };
  }
  const playlists = sampleNvfastPlaylists(rows);
  if (!playlists.length) {
    return { video: false, note: 'no row names an NDOT playlist' };
  }
  let result;
  try {
    result = await probeNvfastVideo(playlists, probe ?? {});
  } catch (error) {
    return {
      video: false,
      note: `probe failed (${error?.message || error}), registering stills`,
    };
  }
  const video = result.answered > 0;
  const tally = `probe ${result.answered}/${result.probed} playlists answered`;
  const stopped =
    result.refused === null ? '' : `, stopped at HTTP ${result.refused}`;
  return {
    video,
    note: `${tally}${stopped}, registering ${video ? 'NDOT video' : 'stills'}`,
  };
}

/**
 * Load the FAST cameras: one page request, nearest the valley first, capped
 * by CCTV_NVFAST_MAX_SOURCES. Rows that name an NDOT playlist register as
 * live video, the still as the snapshot fallback, when resolveNvfastVideo
 * finds NDOT answering (or CCTV_NVFAST_VIDEO=1 says so), as stills
 * otherwise; `options.probe` tunes that probe (tests). Fails soft to an
 * empty pack.
 */
export async function loadNvfastSources(options = {}, env = process.env) {
  const url = String(env.CCTV_NVFAST_URL || '').trim() || NVFAST_CATALOG_URL;
  try {
    const resp = await fetch(url, {
      headers: {
        Accept: 'text/html',
        'User-Agent': NVFAST_USER_AGENT,
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
    const { video, note } = await resolveNvfastVideo(rows, env, options?.probe);
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
      `[CCTV] Loaded RTC FAST camera sources: ${cameras.length} published (using nearest ${prioritized.length}, ${live} with NDOT video; ${note})`,
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
