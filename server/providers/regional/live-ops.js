import {
  LIVE_OPS_REGIONS,
  liveOpsRegion,
} from '../../../src/data/liveOpsRegions.js';
import { makeRateLimiter, clientKey } from '../common/rate-limit.js';
import { coalesceProxyRequest } from '../common/http.js';
import { fetchLiveOpsHeadlines } from './news.js';

// ---------------------------------------------------------------------------
// LIVE OPS region headlines proxy
//
//   GET /api/live-ops/headlines?region=<id>
//
// One cached answer per region: Google News RSS first, GDELT when that is
// empty or unreachable, exactly as the cockpit's regional brief, but with
// the registry's region query rather than a reverse-geocoded locality.
// ---------------------------------------------------------------------------
export const LIVE_OPS_HEADLINES_CACHE_MS = 3 * 60_000;
export const LIVE_OPS_HEADLINES_STALE_MS = 60 * 60_000;

export function liveOpsHeadlinesProxy({
  headlines = fetchLiveOpsHeadlines,
  now = () => Date.now(),
} = {}) {
  const cache = new Map();
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 120 });

  async function refresh(region) {
    const news = await headlines(region);
    if (news.status === 'unavailable')
      throw new Error('headline sources unavailable');
    const payload = {
      status: news.status,
      retrievedAt: new Date(now()).toISOString(),
      region: region.id,
      name: region.name,
      query: news.query,
      source: news.source,
      articles: news.articles,
    };
    cache.set(region.id, { payload, cachedAt: now() });
    return payload;
  }

  async function headlinesFor(region) {
    const cached = cache.get(region.id);
    const at = now();
    if (cached && at - cached.cachedAt <= LIVE_OPS_HEADLINES_CACHE_MS)
      return { payload: { ...cached.payload, status: 'cached' }, hit: 'HIT' };
    const request = coalesceProxyRequest(inFlight, region.id, () =>
      refresh(region),
    );
    try {
      return {
        payload: await request.promise,
        hit: request.shared ? 'INFLIGHT' : 'MISS',
      };
    } catch (error) {
      if (cached && at - cached.cachedAt <= LIVE_OPS_HEADLINES_STALE_MS)
        return {
          payload: { ...cached.payload, status: 'stale' },
          hit: 'STALE',
        };
      throw error;
    }
  }

  function install(middlewares) {
    middlewares.use('/api/live-ops/headlines', async (req, res) => {
      const json = (status, value, headers = {}) => {
        if (res.destroyed) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          ...headers,
        });
        res.end(JSON.stringify(value));
      };
      if (req.method !== 'GET')
        return json(405, { error: 'Method Not Allowed' }, { Allow: 'GET' });
      if (!allow(clientKey(req)))
        return json(
          429,
          { error: 'Rate limit exceeded' },
          { 'Retry-After': '10' },
        );
      const url = new URL(req.url || '', 'http://localhost');
      const region = liveOpsRegion(url.searchParams.get('region'));
      if (!region)
        return json(400, {
          error: 'A LIVE OPS region is required',
          regions: LIVE_OPS_REGIONS.map((entry) => entry.id),
        });
      try {
        const { payload, hit } = await headlinesFor(region);
        return json(200, payload, { 'X-Live-Ops-Headlines': hit });
      } catch {
        return json(503, { error: 'Headlines are temporarily unavailable' });
      }
    });
  }

  return {
    name: 'live-ops-headlines-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
    /** Exposed for tests and tools that want a region's headlines directly. */
    headlines: (regionId) => {
      const region = liveOpsRegion(regionId);
      if (!region) throw new Error('unknown region');
      return headlinesFor(region).then((result) => result.payload);
    },
  };
}
