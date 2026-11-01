/**
 * The alerts provider: every official alert and status feed the Alerts
 * layer reads, each behind its own request governor, assembled into one
 * normalized payload for the LIVE OPS regions.
 *
 *   GET /api/alerts[?region=<id>][&kind=<k>[,<k>…]][&severity=<min>]
 *        → { schemaVersion, fetchedAt, stale, region, regions, sources, alerts }
 *   GET /api/alerts/airports  → FAA status: the regions' airports and every
 *        airport the FAA lists with a closure, stop or delay
 *   GET /api/alerts/airnow    → AirNow site readings (503 `no_key` keyless)
 *   GET /api/alerts/status    → per-feed governor diagnostics, no data
 *
 * Fixed upstream addresses only; the browser never names a URL. Every feed
 * keeps its own TTL, hourly budget, cooldown ladder and serve-stale window
 * (governor.js), so a tab polling every two minutes, or ten tabs, costs each
 * public API the same bounded number of requests an hour. Failures are
 * reported as short codes (http.js `upstreamErrorCode`), never as upstream
 * text.
 */
import {
  ALERT_KIND_IDS,
  ALERT_SEVERITY_IDS,
  AIRPORT_STATUS_KINDS,
  compareAlerts,
  feedFreshness,
  filterAlerts,
  severityRank,
} from '../../../src/layers/alerts/model.js';
import {
  ALERT_AIRPORTS,
  ALERT_REGIONS,
  ALERT_REGION_IDS,
  alertRegion,
  regionsForAirport,
} from '../../../src/layers/alerts/regions.js';
import { coalesceProxyRequest } from '../common/http.js';
import { makeRateLimiter, clientKey } from '../common/rate-limit.js';
import { admitSameSite, admitSameSiteKeyless } from '../common/same-site.js';
import { createAgencyFeedSources } from './agencies.js';
import { createAirNowFeedSource } from './airnow.js';
import { createCalFireFeedSource } from './calfire.js';
import { createCaltransFeedSource } from './caltrans.js';
import { FAA_STATUS_PAGE, createFaaFeedSource } from './faa.js';
import { createFeedGovernor } from './governor.js';
import { upstreamErrorCode } from './http.js';
import { createNwsFeedSource } from './nws.js';
import { createTransitFeedSources } from './transit.js';

/** How long one assembled payload answers every caller before reassembly. */
export const ALERTS_ASSEMBLY_TTL_MS = 20_000;

/**
 * Every feed source with its governor attached. Keyed feeds stay in the
 * list while their key is absent (`keyMissing()`), so the payload can say why
 * they are silent; they are never requested until the key is set.
 */
export function createAlertFeedSources({
  fetchImpl,
  now = () => Date.now(),
  env = {},
} = {}) {
  const sources = [
    createNwsFeedSource({ fetchImpl, now }),
    createCalFireFeedSource({ fetchImpl, now }),
    createCaltransFeedSource({ fetchImpl, now }),
    createFaaFeedSource({ fetchImpl, now }),
    createAirNowFeedSource({ fetchImpl, now, env }),
    ...createTransitFeedSources({ fetchImpl, now, env }),
    ...createAgencyFeedSources({ fetchImpl, now }),
  ];
  return sources.map((source) => ({
    ...source,
    governor: createFeedGovernor({
      id: source.id,
      ttlMs: source.refreshMs,
      staleMaxMs: source.staleMaxMs,
      budgetPerHour: source.budgetPerHour,
      now,
    }),
  }));
}

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/** A failure code fit to publish: the short identifier form only. */
const safeCode = (code) =>
  /^[a-z][a-z0-9_]{0,40}$/.test(String(code ?? ''))
    ? String(code)
    : 'unavailable';

/** Whether a keyed source is waiting for its key. */
export const sourceKeyMissing = (source) =>
  typeof source?.keyMissing === 'function'
    ? source.keyMissing() === true
    : false;

/** Ask one source through its governor; never throw. */
export async function readSource(source) {
  if (sourceKeyMissing(source))
    return {
      source,
      status: 'key-required',
      value: null,
      fetchedAt: null,
      stale: false,
      error: null,
    };
  try {
    const result = await source.governor.acquire(source.load);
    return { source, ...result, error: null };
  } catch (error) {
    return {
      source,
      status: 'unavailable',
      value: null,
      fetchedAt: null,
      stale: true,
      error: safeCode(error?.code ?? upstreamErrorCode(error)),
    };
  }
}

/** Assemble one payload from every source's current copy. */
export async function assembleAlerts(sources, { now = () => Date.now() } = {}) {
  const results = await Promise.all(sources.map(readSource));
  const at = now();
  const alerts = [];
  const seen = new Set();
  const statuses = results.map(
    ({ source, status, value, fetchedAt, stale, error }) => {
      const list = Array.isArray(value?.alerts) ? value.alerts : [];
      const freshness =
        stale || !fetchedAt
          ? 'stale'
          : feedFreshness(fetchedAt, source.refreshMs, at);
      for (const alert of list) {
        if (seen.has(alert.id)) continue;
        seen.add(alert.id);
        alerts.push({
          ...alert,
          fetchedAt: iso(fetchedAt) ?? alert.fetchedAt,
          freshness,
        });
      }
      return {
        id: source.id,
        label: source.label,
        home: source.home,
        licence: source.licence,
        refreshMs: source.refreshMs,
        envVar: source.envVar || null,
        regions: [...(source.regions || ALERT_REGION_IDS)],
        status,
        stale: Boolean(stale),
        fetchedAt: iso(fetchedAt),
        count: list.length,
        partial: value?.partial === true,
        error,
      };
    },
  );
  alerts.sort(compareAlerts);
  return {
    schemaVersion: 1,
    fetchedAt: iso(at),
    stale: statuses.some(
      (entry) => entry.stale && entry.status !== 'key-required',
    ),
    region: null,
    regions: ALERT_REGIONS.map(({ id, name, bbox, anchor }) => ({
      id,
      name,
      bbox: [...bbox],
      anchor: { ...anchor },
    })),
    sources: statuses,
    alerts,
  };
}

/**
 * The payload narrowed to one region, some kinds or a minimum severity.
 * Source counts are recounted over the alerts that remain.
 */
export function narrowAlertsPayload(payload, { region, kinds, minSeverity }) {
  if (!region && !kinds?.length && !minSeverity) return payload;
  const alerts = filterAlerts(payload.alerts, { region, kinds, minSeverity });
  const counts = new Map();
  for (const alert of alerts)
    counts.set(alert.source, (counts.get(alert.source) || 0) + 1);
  return {
    ...payload,
    region: region || null,
    sources: payload.sources.map((entry) => ({
      ...entry,
      count: counts.get(entry.id) || 0,
    })),
    alerts,
  };
}

/** The worst status kind among an airport's events, or `normal`. */
function airportStatus(events) {
  let worst = null;
  for (const event of events) {
    const kind = AIRPORT_STATUS_KINDS[event.status];
    if (
      kind &&
      (!worst ||
        severityRank(kind.severity) >
          severityRank(AIRPORT_STATUS_KINDS[worst].severity))
    )
      worst = event.status;
  }
  return worst || 'normal';
}

/** The airport status payload from the FAA source's current copy. */
export function airportsPayload(result) {
  const events = Array.isArray(result.value?.events) ? result.value.events : [];
  const known = (code) => ALERT_AIRPORTS[code] || null;
  return {
    fetchedAt: iso(result.fetchedAt),
    updatedAt: result.value?.updatedAt ?? null,
    stale: Boolean(result.stale),
    status: result.status,
    error: result.error,
    source: 'FAA National Airspace System Status',
    home: FAA_STATUS_PAGE,
    airports: Object.entries(ALERT_AIRPORTS).map(([code, airport]) => {
      const own = events.filter((event) => event.airport === code);
      return {
        code,
        name: airport.name,
        lat: airport.lat,
        lon: airport.lon,
        regions: regionsForAirport(code),
        status: result.value ? airportStatus(own) : 'unknown',
        events: own,
      };
    }),
    events: events.map((event) => ({
      ...event,
      name: known(event.airport)?.name ?? null,
      lat: known(event.airport)?.lat ?? null,
      lon: known(event.airport)?.lon ?? null,
      regions: regionsForAirport(event.airport),
    })),
  };
}

/** Parse the narrowing query, or describe what is wrong with it. */
export function parseAlertsQuery(searchParams) {
  const regionParam = searchParams.get('region');
  const region = regionParam ? alertRegion(regionParam) : null;
  if (regionParam && !region)
    return {
      error: 'unknown_region',
      allowed: ALERT_REGIONS.map((entry) => entry.id),
    };
  const kindParam = searchParams.get('kind');
  const kinds = kindParam
    ? [
        ...new Set(
          kindParam
            .split(',')
            .map((kind) => kind.trim().toLowerCase())
            .filter(Boolean),
        ),
      ]
    : [];
  if (kinds.some((kind) => !ALERT_KIND_IDS.includes(kind)))
    return { error: 'unknown_kind', allowed: [...ALERT_KIND_IDS] };
  const severityParam = searchParams.get('severity');
  const minSeverity = severityParam ? severityParam.trim().toLowerCase() : null;
  if (minSeverity && !ALERT_SEVERITY_IDS.includes(minSeverity))
    return { error: 'unknown_severity', allowed: [...ALERT_SEVERITY_IDS] };
  return { region: region?.id ?? null, kinds, minSeverity };
}

/** Fixed-origin, governed alert routes for dev and preview. */
export function alertsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  env = process.env,
  sources: suppliedSources = null,
} = {}) {
  const sources =
    suppliedSources || createAlertFeedSources({ fetchImpl, now, env });
  const faa = sources.find((source) => source.id === 'faa');
  const airnow = sources.find((source) => source.id === 'airnow');
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 600 });
  const inFlight = new Map();
  let assembled = null;

  function assemble() {
    if (assembled && now() - assembled.at < ALERTS_ASSEMBLY_TTL_MS)
      return Promise.resolve(assembled.payload);
    return coalesceProxyRequest(inFlight, 'alerts', async () => {
      const payload = await assembleAlerts(sources, { now });
      assembled = { payload, at: now() };
      return payload;
    }).promise;
  }

  async function handler(req, res) {
    const json = (status, value, extra = {}) => {
      if (res.destroyed || res.headersSent) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...extra,
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET')
      return json(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    // AirNow spends the operator's key; the rest is keyless public data.
    if (
      path === '/airnow'
        ? admitSameSite(req, res)
        : admitSameSiteKeyless(req, res)
    )
      return undefined;
    if (!allow(clientKey(req)))
      return json(429, { error: 'rate_limited' }, { 'Retry-After': '30' });
    try {
      if (path === '/') {
        const query = parseAlertsQuery(url.searchParams);
        if (query.error) return json(400, query);
        const payload = narrowAlertsPayload(await assemble(), query);
        return json(
          200,
          payload,
          payload.stale ? { 'X-Data-Stale': 'true' } : {},
        );
      }
      if (path === '/airports') {
        const payload = airportsPayload(await readSource(faa));
        return json(
          payload.status === 'unavailable' ? 502 : 200,
          payload,
          payload.stale ? { 'X-Data-Stale': 'true' } : {},
        );
      }
      if (path === '/airnow') {
        if (!airnow || sourceKeyMissing(airnow))
          return json(503, { error: 'no_key', provider: 'airnow' });
        const result = await readSource(airnow);
        if (result.status === 'unavailable')
          return json(502, {
            error: 'airnow_unavailable',
            provider: 'airnow',
            code: result.error,
          });
        return json(
          200,
          {
            provider: 'airnow',
            fetchedAt: iso(result.fetchedAt),
            stale: result.stale,
            status: result.status,
            partial: result.value?.partial === true,
            readings: result.value?.readings || [],
          },
          result.stale ? { 'X-Data-Stale': 'true' } : {},
        );
      }
      if (path === '/status')
        return json(200, {
          sources: sources.map((source) => ({
            keyRequired: sourceKeyMissing(source),
            envVar: source.envVar || null,
            ...source.governor.describe(),
          })),
        });
      return json(404, { error: 'unknown_route' });
    } catch (error) {
      return json(502, {
        error: 'alerts_unavailable',
        code: upstreamErrorCode(error),
      });
    }
  }

  // No return value: Vite treats a function returned from configureServer as
  // a post-middleware hook.
  const install = (server) => {
    server.middlewares.use('/api/alerts', handler);
  };
  return {
    name: 'alerts-proxy',
    configureServer: install,
    configurePreviewServer: install,
    /** The assembled payload, for tools and tests that want it directly. */
    snapshot: (query = {}) =>
      assemble().then((payload) =>
        narrowAlertsPayload(payload, {
          region: query.region ?? null,
          kinds: query.kinds ?? [],
          minSeverity: query.minSeverity ?? null,
        }),
      ),
  };
}
