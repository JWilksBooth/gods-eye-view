/**
 * Vite plugin: live incidents for the LIVE OPS regions.
 *
 *   GET /api/incidents[?region=<id>][&type=<type>]
 *
 * Each source (CHP CAD, DataSF dispatched calls, LAFD alerts, CAL FIRE,
 * Nevada 511 events) refreshes on its own cadence into a process-scoped
 * cache, independently of the others: one feed failing leaves the rest
 * live, and a failed source keeps serving its last snapshot, marked stale,
 * for a bounded time. The answer carries every row inside the regions (or
 * one region), newest first, plus each source's own state so the layer and
 * the tools can say exactly which feed is behind an empty answer.
 */
import {
  LIVE_OPS_REGIONS,
  liveOpsRegion,
} from '../../src/data/liveOpsRegions.js';
import { sortIncidentsNewestFirst } from '../../src/layers/incidents/records.js';
import { admitSameSiteKeyless } from './common/same-site.js';
import { coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { CHP_SOURCE, fetchChpIncidents } from './incidents/chp.js';
import { DATASF_SOURCE, fetchDataSfCalls } from './incidents/datasf.js';
import { CALFIRE_SOURCE, fetchCalFireIncidents } from './incidents/calfire.js';
import { LAFD_SOURCE, createLafdFetcher } from './incidents/lafd.js';
import {
  NVROADS_EVENTS_SOURCE,
  fetchNvroadsEvents,
} from './incidents/nvroadsEvents.js';

/** Longest a failed refresh keeps serving a source's last snapshot, marked stale. */
export const INCIDENT_STALE_MAX_MS = 6 * 60 * 60_000;
/** Rows reported earlier than this are dropped from every answer. */
export const INCIDENT_WINDOW_MS = 24 * 60 * 60_000;
/** A failed source waits this long before it is asked again. */
const FAILURE_RETRY_MS = 30_000;

const envEnabled = (env, name) => String(env[name] ?? '1').trim() !== '0';

/** The sources, in answer order. `enabled` reads the env on every refresh. */
export function incidentSources({
  env = process.env,
  lafd = createLafdFetcher(),
} = {}) {
  return [
    {
      ...CHP_SOURCE,
      enabled: () => envEnabled(env, 'INCIDENTS_CHP_ENABLED'),
      load: fetchChpIncidents,
    },
    {
      ...DATASF_SOURCE,
      enabled: () => envEnabled(env, 'INCIDENTS_DATASF_ENABLED'),
      load: fetchDataSfCalls,
    },
    {
      ...LAFD_SOURCE,
      enabled: () => envEnabled(env, 'INCIDENTS_LAFD_ENABLED'),
      load: lafd,
    },
    {
      ...CALFIRE_SOURCE,
      enabled: () => envEnabled(env, 'INCIDENTS_CALFIRE_ENABLED'),
      load: fetchCalFireIncidents,
    },
    {
      ...NVROADS_EVENTS_SOURCE,
      enabled: () => envEnabled(env, 'INCIDENTS_NVROADS_ENABLED'),
      load: fetchNvroadsEvents,
    },
  ];
}

/** Keep the sources' caches and answer merged snapshots. */
export function createIncidentStore({
  sources,
  fetchImpl = (...args) => globalThis.fetch(...args),
  env = process.env,
  now = () => Date.now(),
  warn = (...args) => console.warn(...args),
} = {}) {
  const state = new Map(
    sources.map((source) => [
      source.id,
      { rows: [], fetchedAt: null, error: null, failedAt: null, ok: false },
    ]),
  );
  const inFlight = new Map();

  async function refresh(source, entry) {
    try {
      const rows = await source.load({ fetchImpl, env, now });
      entry.rows = Array.isArray(rows) ? rows : [];
      entry.fetchedAt = now();
      entry.error = null;
      entry.failedAt = null;
      entry.ok = true;
    } catch (error) {
      entry.error = String(error?.message || error).slice(0, 160);
      entry.failedAt = now();
      entry.ok = false;
      warn(`[incidents] ${source.label} refresh failed:`, entry.error);
      // A snapshot older than the stale ceiling is history, not live data.
      if (
        entry.fetchedAt != null &&
        now() - entry.fetchedAt > INCIDENT_STALE_MAX_MS
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
  async function snapshot({ region = null, type = null } = {}) {
    await Promise.all(
      sources.map((source) => {
        const entry = state.get(source.id);
        if (!source.enabled()) {
          entry.rows = [];
          entry.ok = false;
          entry.error = 'disabled';
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
    const rows = [];
    const sourceStates = [];
    let anyLive = false;
    for (const source of sources) {
      const entry = state.get(source.id);
      const stale =
        entry.fetchedAt != null && !entry.ok && entry.rows.length > 0;
      if (entry.ok) anyLive = true;
      sourceStates.push({
        id: source.id,
        label: source.label,
        agency: source.agency,
        ok: entry.ok,
        stale,
        count: 0,
        fetchedAt: entry.fetchedAt,
        refreshMs: source.refreshMs,
        error: entry.ok ? null : entry.error,
      });
      for (const row of entry.rows) {
        if (regionId && row.region !== regionId) continue;
        if (type && row.type !== type) continue;
        if (row.time != null && at - row.time > INCIDENT_WINDOW_MS) continue;
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
      rows: sortIncidentsNewestFirst(rows),
    };
  }

  return { snapshot, sources };
}

const TYPES = new Set([
  'traffic',
  'fire',
  'medical',
  'police',
  'hazard',
  'closure',
  'other',
]);

export function incidentsProxy(options = {}) {
  const env = options.env ?? process.env;
  const store = createIncidentStore({
    sources: options.sources ?? incidentSources({ env }),
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
    if (url.pathname !== '/' && url.pathname !== '')
      return json(404, { error: 'unknown_route' });
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    const region = url.searchParams.get('region');
    if (region && !liveOpsRegion(region))
      return json(400, {
        error: 'unknown_region',
        regions: LIVE_OPS_REGIONS.map((entry) => entry.id),
      });
    const type = url.searchParams.get('type');
    if (type && !TYPES.has(type))
      return json(400, { error: 'unknown_type', types: [...TYPES] });
    try {
      return json(200, await store.snapshot({ region, type }));
    } catch (error) {
      return json(503, {
        error: 'incidents_unavailable',
        detail: String(error?.message || error).slice(0, 160),
      });
    }
  }

  // No return value: Vite treats a function returned from configureServer as
  // a post-middleware hook, and connect's use() returns the app function.
  const install = (server) => {
    server.middlewares.use('/api/incidents', handler);
  };
  return {
    name: 'incidents-proxy',
    configureServer: install,
    configurePreviewServer: install,
    /** Exposed for tools and tests that want the merged snapshot directly. */
    snapshot: (query) => store.snapshot(query),
  };
}
