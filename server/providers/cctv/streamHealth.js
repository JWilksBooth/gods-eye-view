/**
 * Per-camera stream health for the camera proxy: when each camera's
 * playlist last answered and when it last failed. The proxy learns it from
 * the HLS leases it pulls (stream.js reports every verdict) and from a
 * bounded probe of playlists: a small sample per video-capable provider
 * when the catalog first loads, then the cameras a browser surface asks
 * about, never a camera whose verdict is still fresh. In memory and bounded;
 * nothing on disk. The policy that turns the two timestamps into a verdict
 * is src/sources/cctvStreamHealth.js, shared with the browser.
 */
import { CCTV_MAX_SOURCES_CEILING } from './constants.js';
import { fetchWithinHost } from './media.js';
import { normalizeFeedType } from './normalize.js';
import { HLS_LIMITS } from './stream.js';
import { readResponseBytesCapped } from '../../../src/sources/httpBody.js';
import {
  CCTV_STREAM_PROBE_BATCH,
  streamHealthState,
} from '../../../src/sources/cctvStreamHealth.js';

/** Sized to the catalog ceiling: a record per camera the proxy can serve. */
export const STREAM_HEALTH_MAX_ENTRIES = CCTV_MAX_SOURCES_CEILING;

export const STREAM_PROBE_LIMITS = Object.freeze({
  /** Playlists probed per provider when the catalog first loads. */
  perProvider: 8,
  /** Probe requests in flight at once, over every caller. */
  concurrency: 4,
  timeoutMs: 5000,
  /** Cameras one probe request may name. */
  batch: CCTV_STREAM_PROBE_BATCH,
  playlistBytes: HLS_LIMITS.playlistBytes,
});

/** The proxy's own identifying User-Agent, as every upstream request sends. */
export const STREAM_PROBE_USER_AGENT = 'osiris-cctv-proxy/1.0';

/**
 * The registered playlist of a live HLS camera, or null for anything else:
 * the same shape the media route accepts before it pulls a stream.
 * @param {{feedType?: string, url?: string}|null|undefined} source
 * @returns {string|null}
 */
export function hlsPlaylistUrl(source) {
  if (normalizeFeedType(source?.feedType) !== 'hls') return null;
  const url = String(source?.url || '').trim();
  return /^https?:\/\//i.test(url) && /\.m3u8(?:\?|$)/i.test(url) ? url : null;
}

/**
 * The bounded record: last success, last failure and the failure count per
 * camera. A camera touched again moves to the end, so when the cap is
 * reached the camera nobody has asked about for longest goes first.
 *
 * @param {{maxEntries?: number, now?: () => number}} [options]
 */
export function createStreamHealth({
  maxEntries = STREAM_HEALTH_MAX_ENTRIES,
  now = Date.now,
} = {}) {
  const cap = Math.max(1, Math.floor(Number(maxEntries)) || 1);
  /** @type {Map<string, {ok: number, fail: number, failures: number}>} */
  const entries = new Map();
  const key = (cameraId) => String(cameraId ?? '').trim();
  const touch = (cameraId) => {
    const id = key(cameraId);
    if (!id) return null;
    let entry = entries.get(id);
    if (entry) entries.delete(id);
    else {
      entry = { ok: 0, fail: 0, failures: 0 };
      while (entries.size >= cap) entries.delete(entries.keys().next().value);
    }
    entries.set(id, entry);
    return entry;
  };
  return {
    /** The playlist answered: the camera is live and its failures are forgotten. */
    recordSuccess(cameraId) {
      const entry = touch(cameraId);
      if (!entry) return null;
      entry.ok = now();
      entry.failures = 0;
      return { ...entry };
    },
    /** The playlist did not answer. */
    recordFailure(cameraId) {
      const entry = touch(cameraId);
      if (!entry) return null;
      entry.fail = now();
      entry.failures += 1;
      return { ...entry };
    },
    get(cameraId) {
      const entry = entries.get(key(cameraId));
      return entry ? { ...entry } : null;
    },
    /** @returns {'ok'|'down'|'unknown'} */
    state(cameraId, at = now()) {
      return streamHealthState(entries.get(key(cameraId)), at);
    },
    /**
     * The compact wire shape, `{ [cameraId]: { ok, fail } }`: every camera
     * with a record, or only `ids` when given.
     * @param {Iterable<string>} [ids]
     */
    snapshot(ids) {
      const out = {};
      for (const id of ids ? ids : entries.keys()) {
        const entry = entries.get(key(id));
        if (entry) out[key(id)] = { ok: entry.ok, fail: entry.fail };
      }
      return out;
    },
    get size() {
      return entries.size;
    },
  };
}

/**
 * A small sample of each provider's live cameras, spread evenly along the
 * provider's list (Caltrans lists district by district, so the ends of the
 * list are other districts than its middle).
 * @param {Array<object>} sources Catalog sources (`pack`, `feedType`, `url`).
 * @param {number} [perProvider]
 * @returns {Array<object>}
 */
export function sampleStreamSources(
  sources,
  perProvider = STREAM_PROBE_LIMITS.perProvider,
) {
  const want = Math.max(0, Math.floor(Number(perProvider)) || 0);
  const groups = new Map();
  for (const source of Array.isArray(sources) ? sources : []) {
    if (!hlsPlaylistUrl(source)) continue;
    const group = String(source.pack || source.provider || '');
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(source);
  }
  const sample = [];
  for (const list of groups.values()) {
    if (list.length <= want) {
      sample.push(...list);
      continue;
    }
    const step = list.length / want;
    for (let i = 0; i < want; i += 1) sample.push(list[Math.floor(i * step)]);
  }
  return sample;
}

function isHlsPlaylist(bytes) {
  if (!bytes?.byteLength) return false;
  let head = new TextDecoder().decode(bytes.subarray(0, 16));
  if (head.charCodeAt(0) === 0xfeff) head = head.slice(1);
  return head.startsWith('#EXTM3U');
}

/**
 * The probe: one bounded GET of a camera's playlist, redirects kept on the
 * registered origin (fetchWithinHost), the body capped at the puller's
 * playlist budget, a success only when it is an M3U playlist. Verdicts go to
 * `health`. Requests share one concurrency budget whoever asks, and a camera
 * already in flight is not fetched twice.
 *
 * @param {object} options
 * @param {ReturnType<typeof createStreamHealth>} options.health
 * @param {typeof fetch} [options.fetchImpl]
 * @param {typeof STREAM_PROBE_LIMITS} [options.limits]
 * @param {() => number} [options.now]
 */
export function createStreamProbe({
  health,
  fetchImpl = fetch,
  limits = STREAM_PROBE_LIMITS,
  now = Date.now,
} = {}) {
  if (!health) throw new TypeError('A stream health record is required');
  const concurrency = Math.max(1, Math.floor(Number(limits.concurrency)) || 1);
  /** @type {Map<string, Promise<boolean>>} */
  const inFlight = new Map();
  let active = 0;
  const waiting = [];
  const acquire = () =>
    new Promise((resolve) => {
      if (active < concurrency) {
        active += 1;
        resolve();
      } else waiting.push(resolve);
    });
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };

  async function playlistAnswers(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
    timer.unref?.();
    try {
      const response = await fetchWithinHost(
        url,
        {
          headers: { 'User-Agent': STREAM_PROBE_USER_AGENT },
          signal: controller.signal,
        },
        fetchImpl,
      );
      if (!response) return false;
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          /* already closed */
        }
        return false;
      }
      return isHlsPlaylist(
        await readResponseBytesCapped(
          response,
          limits.playlistBytes,
          controller.signal,
        ),
      );
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  function probeOne(source) {
    const id = String(source?.id ?? '').trim();
    const url = hlsPlaylistUrl(source);
    if (!id || !url) return Promise.resolve(false);
    const pending = inFlight.get(id);
    if (pending) return pending;
    const run = (async () => {
      await acquire();
      try {
        const ok = await playlistAnswers(url);
        if (ok) health.recordSuccess(id);
        else health.recordFailure(id);
        return ok;
      } finally {
        release();
        inFlight.delete(id);
      }
    })();
    inFlight.set(id, run);
    return run;
  }

  /**
   * Probe these cameras' playlists: live HLS cameras whose verdict is
   * unknown (none yet, or too old to trust), at most `limit` of them.
   * @param {Array<object>} sources
   * @param {{limit?: number}} [options]
   * @returns {Promise<{requested: number, probed: number, ok: number, failed: number, skipped: number, ms: number}>}
   */
  async function probe(sources, { limit = limits.batch } = {}) {
    const started = now();
    const picked = [];
    const seen = new Set();
    let skipped = 0;
    for (const source of Array.isArray(sources) ? sources : []) {
      if (picked.length >= limit) break;
      const id = String(source?.id ?? '').trim();
      if (!id || seen.has(id) || !hlsPlaylistUrl(source)) continue;
      seen.add(id);
      if (health.state(id, started) !== 'unknown') {
        skipped += 1;
        continue;
      }
      picked.push(source);
    }
    const results = await Promise.all(picked.map(probeOne));
    const ok = results.filter(Boolean).length;
    return {
      requested: seen.size,
      probed: picked.length,
      ok,
      failed: picked.length - ok,
      skipped,
      ms: now() - started,
    };
  }

  /** The one pass at catalog load: a sample per provider. */
  function seed(sources) {
    const sample = sampleStreamSources(sources, limits.perProvider);
    return probe(sample, { limit: sample.length });
  }

  return {
    probe,
    seed,
    get inFlight() {
      return inFlight.size;
    },
  };
}
