/**
 * The alerts provider: every official alert and status feed the Alerts
 * layer reads, each behind its own request governor, assembled into one
 * normalized payload.
 *
 *   GET /api/alerts            → { schemaVersion, fetchedAt, stale, regions, sources, alerts }
 *   GET /api/alerts/airports   → { fetchedAt, updatedAt, stale, status, airports }
 *   GET /api/alerts/status     → per-feed governor diagnostics, no data
 *
 * Fixed upstream addresses only; the browser never names a URL. Every feed
 * keeps its own TTL, hourly budget, cooldown ladder and serve-stale window
 * (governor.js), so a tab polling every two minutes, or ten tabs, costs each
 * public API the same bounded number of requests an hour.
 */
import {
  compareAlerts,
  feedFreshness,
} from '../../../src/layers/alerts/model.js';
import {
  ALERT_AIRPORTS,
  ALERT_REGIONS,
  regionsForAirport,
} from '../../../src/layers/alerts/regions.js';
import { coalesceProxyRequest } from '../common/http.js';
import { makeRateLimiter, clientKey } from '../common/rate-limit.js';
import { createAgencyFeedSources } from './agencies.js';
import { createCalFireFeedSource } from './calfire.js';
import { createCaltransFeedSource } from './caltrans.js';
import { createFaaFeedSource } from './faa.js';
import { createFeedGovernor } from './governor.js';
import { createNwsFeedSource } from './nws.js';
import { createTransitFeedSources } from './transit.js';

/** How long one assembled payload answers every caller before reassembly. */
export const ALERTS_ASSEMBLY_TTL_MS = 20_000;

/** A log-safe error text: never a URL, which might carry a key. */
function describeError(error) {
  const text = String(error?.message || error || 'unavailable');
  return text.replace(/https?:\/\/\S+/gi, '[url]').slice(0, 160);
}

/**
 * Every feed source with its governor attached. Keyed feeds without a key
 * stay in the list with `keyRequired: true` so the payload can say why they
 * are silent.
 */
export function createAlertFeedSources({ fetchImpl, now = () => Date.now(), env = {} } = {}) {
  const sources = [
    createNwsFeedSource({ fetchImpl, now }),
    createCalFireFeedSource({ fetchImpl, now }),
    createCaltransFeedSource({ fetchImpl, now }),
    createFaaFeedSource({ fetchImpl, now }),
    ...createTransitFeedSources({ fetchImpl, now, env }),
    ...createAgencyFeedSources({ fetchImpl, now }),
  ];
  return sources.map((source) => ({
    ...source,
    keyRequired: source.keyRequired === true,
    governor: createFeedGovernor({
      id: source.id,
      ttlMs: source.refreshMs,
      staleMaxMs: source.staleMaxMs,
      budgetPerHour: source.budgetPerHour,
      now,
    }),
  }));
}

/** Ask one source through its governor; never throw. */
async function readSource(source) {
  if (source.keyRequired)
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
      error: describeError(error),
    };
  }
}

/** Assemble one payload from every source's current copy. */
export async function assembleAlerts(sources, { now = () => Date.now() } = {}) {
  const results = await Promise.all(sources.map(readSource));
  const at = now();
  const alerts = [];
  const seen = new Set();
  const statuses = results.map(({ source, status, value, fetchedAt, stale, error }) => {
    const list = Array.isArray(value?.alerts) ? value.alerts : [];
    const freshness =
      stale || !fetchedAt ? 'stale' : feedFreshness(fetchedAt, source.refreshMs, at);
    for (const alert of list) {
      if (seen.has(alert.id)) continue;
      seen.add(alert.id);
      alerts.push({
        ...alert,
        fetchedAt: fetchedAt ? new Date(fetchedAt).toISOString() : alert.fetchedAt,
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
      status,
      stale: Boolean(stale),
      fetchedAt: fetchedAt ? new Date(fetchedAt).toISOString() : null,
      count: list.length,
      partial: value?.partial === true,
      error,
    };
  });
  alerts.sort(compareAlerts);
  return {
    schemaVersion: 1,
    fetchedAt: new Date(at).toISOString(),
    stale: statuses.some((entry) => entry.stale && entry.status !== 'key-required'),
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

/** The airport status payload from the FAA source's current copy. */
function airportsPayload(result) {
  const events = Array.isArray(result.value?.events) ? result.value.events : [];
  return {
    fetchedAt: result.fetchedAt ? new Date(result.fetchedAt).toISOString() : null,
    updatedAt: result.value?.updatedAt ?? null,
    stale: Boolean(result.stale),
    status: result.status,
    error: result.error,
    source: 'FAA National Airspace System Status',
    home: 'https://nasstatus.faa.gov/',
    airports: events.map((event) => {
      const known = ALERT_AIRPORTS[event.airport] || null;
      return {
        ...event,
        name: known?.name ?? null,
        lat: known?.lat ?? null,
        lon: known?.lon ?? null,
        regions: regionsForAirport(event.airport),
      };
    }),
  };
}

/** Fixed-origin, governed alert routes for dev and preview. */
export function alertsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  env = process.env,
} = {}) {
  const sources = createAlertFeedSources({ fetchImpl, now, env });
  const faa = sources.find((source) => source.id === 'faa');
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
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...extra,
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET')
      return json(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
    const path = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';
    if (!allow(clientKey(req)))
      return json(429, { error: 'rate_limited' }, { 'Retry-After': '30' });
    try {
      if (path === '/') {
        const payload = await assemble();
        return json(200, payload, payload.stale ? { 'X-Data-Stale': 'true' } : {});
      }
      if (path === '/airports') {
        const payload = airportsPayload(await readSource(faa));
        return json(
          payload.status === 'unavailable' ? 502 : 200,
          payload,
          payload.stale ? { 'X-Data-Stale': 'true' } : {},
        );
      }
      if (path === '/status')
        return json(200, {
          sources: sources.map((source) => ({
            keyRequired: source.keyRequired,
            envVar: source.envVar || null,
            ...source.governor.describe(),
          })),
        });
      return json(404, { error: 'unknown_route' });
    } catch (error) {
      return json(502, { error: 'alerts_unavailable', detail: describeError(error) });
    }
  }

  return {
    name: 'alerts',
    configureServer({ middlewares }) {
      middlewares.use('/api/alerts', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/alerts', handler);
    },
  };
}
