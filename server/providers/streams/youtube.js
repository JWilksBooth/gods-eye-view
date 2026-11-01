/**
 * YouTube Data API v3 discovery of live streams near each LIVE OPS region.
 *
 * `search.list` with `eventType=live`, `type=video`, `videoEmbeddable=true`
 * and a `location`/`locationRadius` pair returns the live, embeddable
 * videos YouTube knows to be recorded near a point. Since June 2026 the
 * method has its own bucket of 100 calls a day, so this module keeps:
 *
 * - an hourly cache per region (four regions make 96 calls a day at most);
 * - a daily budget (`YOUTUBE_SEARCH_DAILY_BUDGET`, default 90, UTC day)
 *   below the bucket, after which every region serves its cached result;
 * - a disk copy (`.gev-cache/streams-youtube.json`) so a dev-server restart
 *   neither re-spends the budget nor forgets it, with entries deleted after
 *   30 days as the API terms require cached data to be refreshed or deleted.
 *
 * `recordingDetails.location` is deprecated, so a discovered stream has no
 * coordinates of its own: it is placed at the centre of the region it was
 * found near and says so (`placement: 'region-centre'`). Nothing here is
 * fetched without `YOUTUBE_API_KEY`.
 */
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { LIVE_OPS_REGIONS } from '../../../src/data/liveOpsRegions.js';
import { streamRecord } from '../../../src/layers/streams/records.js';
import { fetchStreamsUpstream, regionRadiusKm, utcDay } from './common.js';

export const YOUTUBE_SOURCE = Object.freeze({
  id: 'youtube',
  label: 'YouTube live discovery',
  keyEnv: 'YOUTUBE_API_KEY',
  refreshMs: 5 * 60_000,
});
export const YOUTUBE_SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';
/** One search per region per hour. */
export const YOUTUBE_REGION_CACHE_MS = 60 * 60_000;
/** Calls a UTC day may spend of the 100-call `search.list` bucket. */
export const YOUTUBE_DEFAULT_DAILY_BUDGET = 90;
/** Cached API data is refreshed or deleted within 30 days (API terms). */
export const YOUTUBE_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
export const YOUTUBE_MAX_RESULTS = 25;
/** `locationRadius` accepts at most 1000 km. */
export const YOUTUBE_MAX_RADIUS_KM = 1000;

const TERMS =
  'Live stream found through the YouTube Data API near the region; embedded with the standard YouTube player, the channel’s terms apply';

/** The daily budget from the environment: a positive integer, else the default. */
export function youtubeDailyBudget(env = process.env) {
  const parsed = Number.parseInt(String(env.YOUTUBE_SEARCH_DAILY_BUDGET ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, 100)
    : YOUTUBE_DEFAULT_DAILY_BUDGET;
}

/** The `search.list` request for one region. Never log it: it carries the key. */
export function youtubeSearchUrl({
  key,
  region,
  maxResults = YOUTUBE_MAX_RESULTS,
}) {
  const url = new URL(YOUTUBE_SEARCH_URL);
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('eventType', 'live');
  url.searchParams.set('type', 'video');
  url.searchParams.set('videoEmbeddable', 'true');
  url.searchParams.set(
    'location',
    `${region.center.lat.toFixed(4)},${region.center.lon.toFixed(4)}`,
  );
  url.searchParams.set(
    'locationRadius',
    `${regionRadiusKm(region, { max: YOUTUBE_MAX_RADIUS_KM })}km`,
  );
  url.searchParams.set('maxResults', String(Math.max(1, Math.min(50, maxResults))));
  url.searchParams.set('safeSearch', 'moderate');
  url.searchParams.set('key', key);
  return url.toString();
}

/**
 * The live videos of one `search.list` answer as rows placed at the
 * region's centre. Upcoming broadcasts and non-video ids are dropped.
 * @param {object} payload The API answer.
 * @param {{region: object, now: number}} context
 * @returns {object[]}
 */
export function parseYoutubeSearch(payload, { region, now }) {
  const items = Array.isArray(payload?.items) ? payload.items : null;
  if (!items) throw new Error('YouTube answered no items');
  const rows = [];
  for (const item of items) {
    const videoId = item?.id?.videoId;
    const snippet = item?.snippet || {};
    if (item?.id?.kind !== 'youtube#video' || !videoId) continue;
    if (snippet.liveBroadcastContent && snippet.liveBroadcastContent !== 'live')
      continue;
    const thumbnails = snippet.thumbnails || {};
    const row = streamRecord({
      id: videoId,
      source: YOUTUBE_SOURCE.id,
      sourceLabel: YOUTUBE_SOURCE.label,
      title: snippet.title,
      lat: region.center.lat,
      lon: region.center.lon,
      region: region.id,
      kind: 'youtube',
      videoId,
      poster:
        thumbnails.high?.url || thumbnails.medium?.url || thumbnails.default?.url,
      owner: snippet.channelTitle,
      terms: TERMS,
      placement: 'region-centre',
      verifiedAt: now,
      description: `Live near ${region.name}; placed at the region centre because YouTube no longer publishes recording locations`,
      tags: ['discovered'],
    });
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * The per-region cache, the daily budget and the disk copy.
 * @param {object} [options]
 * @param {string} [options.cachePath] Disk copy; null disables it.
 * @param {() => number} [options.now]
 * @param {Function} [options.warn]
 * @param {number} [options.budgetLimit] Overrides the environment budget.
 */
export function createYoutubeDiscovery({
  cachePath = path.join(process.cwd(), '.gev-cache', 'streams-youtube.json'),
  now = () => Date.now(),
  warn = (...args) => console.warn(...args),
  budgetLimit = null,
  readFile = (file) => fsp.readFile(file, 'utf8'),
  writeFile = async (file, text) => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, text, 'utf8');
  },
  regions = LIVE_OPS_REGIONS,
} = {}) {
  const state = { day: null, used: 0, regions: new Map() };
  let restored = false;

  async function restore(at) {
    if (restored) return;
    restored = true;
    if (!cachePath) return;
    try {
      const parsed = JSON.parse(await readFile(cachePath));
      if (parsed?.budget?.day && Number.isFinite(parsed.budget.used)) {
        state.day = String(parsed.budget.day);
        state.used = Math.max(0, Math.floor(parsed.budget.used));
      }
      for (const [id, entry] of Object.entries(parsed?.regions || {})) {
        if (!Number.isFinite(entry?.fetchedAt) || !Array.isArray(entry?.rows))
          continue;
        if (at - entry.fetchedAt > YOUTUBE_CACHE_MAX_AGE_MS) continue;
        state.regions.set(id, { fetchedAt: entry.fetchedAt, rows: entry.rows });
      }
    } catch {
      /* no disk cache yet */
    }
  }

  async function persist() {
    if (!cachePath) return;
    try {
      await writeFile(
        cachePath,
        JSON.stringify({
          budget: { day: state.day, used: state.used },
          regions: Object.fromEntries(state.regions),
        }),
      );
    } catch (error) {
      warn('[streams] YouTube cache write failed:', error?.message || error);
    }
  }

  function rollDay(at) {
    const day = utcDay(at);
    if (state.day !== day) {
      state.day = day;
      state.used = 0;
    }
  }

  function limit(env) {
    return budgetLimit ?? youtubeDailyBudget(env);
  }

  /** Every cached row, refreshing the regions that are due while budget remains. */
  async function load({ fetchImpl, env = process.env, now: at = now() } = {}) {
    const key = String(env[YOUTUBE_SOURCE.keyEnv] ?? '').trim();
    if (!key) throw Object.assign(new Error('no_key'), { code: 'no_key' });
    await restore(at);
    rollDay(at);
    let changed = false;
    for (const region of regions) {
      const cached = state.regions.get(region.id);
      const due = !cached || at - cached.fetchedAt >= YOUTUBE_REGION_CACHE_MS;
      if (!due) continue;
      if (state.used >= limit(env)) continue;
      state.used += 1;
      changed = true;
      try {
        const payload = await fetchStreamsUpstream(
          youtubeSearchUrl({ key, region }),
          { fetchImpl },
        );
        state.regions.set(region.id, {
          fetchedAt: at,
          rows: parseYoutubeSearch(payload, { region, now: at }),
        });
      } catch (error) {
        warn(
          `[streams] YouTube discovery for ${region.id} failed:`,
          error?.status ? `HTTP ${error.status}` : error?.message || error,
        );
      }
    }
    for (const [id, entry] of state.regions) {
      if (at - entry.fetchedAt > YOUTUBE_CACHE_MAX_AGE_MS) {
        state.regions.delete(id);
        changed = true;
      }
    }
    if (changed) await persist();
    return [...state.regions.values()].flatMap((entry) => entry.rows);
  }

  function status(env = process.env) {
    return {
      budget: { day: state.day, used: state.used, limit: limit(env) },
      regions: Object.fromEntries(
        [...state.regions].map(([id, entry]) => [id, entry.fetchedAt]),
      ),
    };
  }

  return { load, status };
}
