/**
 * Vite plugin: geotagged live streams for the LIVE OPS regions.
 *
 *   GET /api/streams[?region=<id>][&kind=<kind>][&source=<source>]
 *   GET /api/streams/status
 *
 * The answer is metadata only: where a stream is, who publishes it and how
 * it would play (`src/layers/streams/records.js`). No media passes through
 * this server; a player is created by the browser only when a person opens
 * a stream, and the YouTube and Windy keys never leave the server.
 *
 * Four sources refresh independently into a process-scoped cache (the
 * incidents provider's pattern): the curated registry (keyless, one JSON
 * file per region), YouTube Data API discovery (`YOUTUBE_API_KEY`, hourly
 * per region under a daily budget), Windy webcams (`WINDY_WEBCAMS_API_KEY`,
 * hourly per region, image URLs served only while fresh) and the scanner
 * link-outs (static). Keyless, the layer serves the registry and the
 * link-outs. A failed source keeps serving its last snapshot, marked stale,
 * for a bounded time, and upstream error text is never relayed.
 */
import {
  LIVE_OPS_REGIONS,
  liveOpsRegion,
} from '../../src/data/liveOpsRegions.js';
import {
  STREAM_KINDS,
  STREAM_SOURCES,
  sortStreams,
} from '../../src/layers/streams/records.js';
import { admitSameSiteKeyless } from './common/same-site.js';
import { coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { defaultSourceRoot } from './common/source-root.js';
import { REGISTRY_SOURCE, loadRegistryStreams } from './streams/registry.js';
import { SCANNER_SOURCE, scannerStreams } from './streams/scanners.js';
import { YOUTUBE_SOURCE, createYoutubeDiscovery } from './streams/youtube.js';
import { WINDY_SOURCE, createWindyDiscovery } from './streams/windy.js';

/** Longest a failed refresh keeps serving a source's last snapshot, marked stale. */
export const STREAM_STALE_MAX_MS = 24 * 60 * 60_000;
/** A failed source waits this long before it is asked again. */
const FAILURE_RETRY_MS = 30_000;

const envEnabled = (env, name) => String(env[name] ?? '1').trim() !== '0';

/** The sources, in answer order. `enabled` reads the env on every refresh. */
export function streamSources({
  env = process.env,
  sourceRoot = defaultSourceRoot,
  youtube = createYoutubeDiscovery(),
  windy = createWindyDiscovery(),
} = {}) {
  return [
    {
      ...REGISTRY_SOURCE,
      enabled: () => envEnabled(env, 'STREAMS_REGISTRY_ENABLED'),
      load: () => loadRegistryStreams({ sourceRoot }),
    },
    {
      ...YOUTUBE_SOURCE,
      enabled: () => envEnabled(env, 'STREAMS_YOUTUBE_ENABLED'),
      load: (context) => youtube.load(context),
      status: (environment) => youtube.status(environment),
    },
    {
      ...WINDY_SOURCE,
      enabled: () => envEnabled(env, 'STREAMS_WINDY_ENABLED'),
      load: (context) => windy.load(context),
      present: (rows, at) => windy.present(rows, at),
      status: () => windy.status(),
    },
    {
      ...SCANNER_SOURCE,
      enabled: () => envEnabled(env, 'STREAMS_SCANNERS_ENABLED'),
      load: async () => scannerStreams(),
    },
  ];
}

/** Keep the sources' caches and answer merged snapshots. */
export function createStreamStore({
  sources,
  fetchImpl = (...args) => globalThis.fetch(...args),
  env = process.env,
  now = () => Date.now(),
  warn = (...args) => console.warn(...args),
} = {}) {
  const state = new Map(
    sources.map((source) => [
      source.id,
      {
        rows: [],
        fetchedAt: null,
        error: null,
        failedAt: null,
        ok: false,
        keyRequired: false,
      },
    ]),
  );
  const inFlight = new Map();

  async function refresh(source, entry) {
    try {
      const rows = await source.load({ fetchImpl, env, now: now() });
      entry.rows = Array.isArray(rows) ? rows : [];
      entry.fetchedAt = now();
      entry.error = null;
      entry.failedAt = null;
      entry.ok = true;
      entry.keyRequired = false;
    } catch (error) {
      if (error?.code === 'no_key') {
        // Keyless is a normal state, not a failure: nothing was asked upstream.
        entry.rows = [];
        entry.fetchedAt = now();
        entry.error = 'no_key';
        entry.failedAt = null;
        entry.ok = false;
        entry.keyRequired = true;
        return entry;
      }
      entry.error = String(error?.message || error).slice(0, 160);
      entry.failedAt = now();
      entry.ok = false;
      warn(`[streams] ${source.label} refresh failed:`, entry.error);
      if (
        entry.fetchedAt != null &&
        now() - entry.fetchedAt > STREAM_STALE_MAX_MS
      )
        entry.rows = [];
    }
    return entry;
  }

  function due(source, entry) {
    const at = now();
    if (entry.failedAt != null && at - entry.failedAt < FAILURE_RETRY_MS)
      return false;
    return entry.fetchedAt == null || at - entry.fetchedAt >= source.refreshMs;
  }

  /** Refresh every due source (coalesced per source) and return the merged snapshot. */
  async function snapshot({ region = null, kind = null, source: only = null } = {}) {
    await Promise.all(
      sources.map((source) => {
        const entry = state.get(source.id);
        if (!source.enabled()) {
          entry.rows = [];
          entry.ok = false;
          entry.error = 'disabled';
          entry.keyRequired = false;
          return null;
        }
        if (!due(source, entry)) return null;
        return coalesceProxyRequest(inFlight, source.id, () =>
          refresh(source, entry),
        ).promise.catch(() => null);
      }),
    );
    const at = now();
    const regionId = region ? (liveOpsRegion(region)?.id ?? null) : null;
    const curatedVideoIds = new Set(
      (state.get(REGISTRY_SOURCE.id)?.rows || [])
        .map((row) => row.embed?.videoId)
        .filter(Boolean),
    );
    const rows = [];
    const sourceStates = [];
    let anyLive = false;
    for (const source of sources) {
      const entry = state.get(source.id);
      const stale =
        entry.fetchedAt != null && !entry.ok && !entry.keyRequired && entry.rows.length > 0;
      if (entry.ok) anyLive = true;
      sourceStates.push({
        id: source.id,
        label: source.label,
        ok: entry.ok,
        stale,
        keyRequired: entry.keyRequired,
        count: 0,
        fetchedAt: entry.fetchedAt,
        refreshMs: source.refreshMs,
        error: entry.ok ? null : entry.error,
      });
      const presented =
        typeof source.present === 'function'
          ? source.present(entry.rows, at)
          : entry.rows;
      for (const row of presented) {
        if (regionId && row.region !== regionId) continue;
        if (kind && row.kind !== kind) continue;
        if (only && row.source !== only) continue;
        // A discovered video already in the registry keeps its curated position.
        if (
          row.source === YOUTUBE_SOURCE.id &&
          curatedVideoIds.has(row.embed?.videoId)
        )
          continue;
        rows.push(row);
        sourceStates.at(-1).count += 1;
      }
    }
    return {
      fetchedAt: at,
      stale: !anyLive && rows.length > 0,
      region: regionId,
      regions: LIVE_OPS_REGIONS.map((entry) => entry.id),
      sources: sourceStates,
      rows: sortStreams(rows),
    };
  }

  /** Key presence and discovery budgets, with nothing secret in it. */
  function status() {
    const result = { fetchedAt: now() };
    for (const source of sources) {
      if (!source.keyEnv) continue;
      result[source.id] = {
        hasKey: String(env[source.keyEnv] ?? '').trim() !== '',
        enabled: source.enabled(),
        ...(typeof source.status === 'function' ? source.status(env) : {}),
      };
    }
    return result;
  }

  return { snapshot, status, sources };
}

const KINDS = new Set(STREAM_KINDS);
const SOURCES = new Set(STREAM_SOURCES);

export function streamsProxy(options = {}) {
  const env = options.env ?? process.env;
  const store = createStreamStore({
    sources: options.sources ?? streamSources({ env, sourceRoot: options.sourceRoot }),
    fetchImpl: options.fetchImpl,
    env,
    now: options.now,
    warn: options.warn,
  });
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 600 });

  async function handler(req, res) {
    const json = (status, value) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(status === 429 ? { 'Retry-After': '10' } : {}),
        ...(value?.stale ? { 'X-Data-Stale': 'true' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    if (admitSameSiteKeyless(req, res)) return undefined;
    const url = new URL(req.url || '/', 'http://localhost');
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    if (url.pathname === '/status') return json(200, store.status());
    if (url.pathname !== '/' && url.pathname !== '')
      return json(404, { error: 'unknown_route' });
    const region = url.searchParams.get('region');
    if (region && !liveOpsRegion(region))
      return json(400, {
        error: 'unknown_region',
        regions: LIVE_OPS_REGIONS.map((entry) => entry.id),
      });
    const kind = url.searchParams.get('kind');
    if (kind && !KINDS.has(kind))
      return json(400, { error: 'unknown_kind', kinds: [...KINDS] });
    const source = url.searchParams.get('source');
    if (source && !SOURCES.has(source))
      return json(400, { error: 'unknown_source', sources: [...SOURCES] });
    try {
      return json(200, await store.snapshot({ region, kind, source }));
    } catch {
      // Never relay what an upstream or a loader said.
      return json(503, { error: 'streams_unavailable' });
    }
  }

  // No return value: Vite treats a function returned from configureServer as
  // a post-middleware hook, and connect's use() returns the app function.
  const install = (server) => {
    server.middlewares.use('/api/streams', handler);
  };
  return {
    name: 'streams-proxy',
    configureServer: install,
    configurePreviewServer: install,
    /** Exposed for tools and tests that want the merged snapshot directly. */
    snapshot: (query) => store.snapshot(query),
    status: () => store.status(),
  };
}
