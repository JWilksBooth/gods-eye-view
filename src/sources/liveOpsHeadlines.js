import { readResponseJsonCapped } from './httpBody.js';
import { normalizeRegionalArticles } from '../data/regionalModel.js';

// A portable export: no i18n, no DOM. Failures stay English data.
const msg = (text) => text;

/**
 * Region headlines through the same-origin `/api/live-ops/headlines` proxy.
 * `getHeadlines(regionId)` resolves to `{ status, region, name, query,
 * source, articles, retrievedAt }`; articles are re-validated here so a
 * panel never trusts a title or link it did not check.
 */
export function createLiveOpsHeadlineSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getHeadlines(regionId, { signal } = {}) {
      signal?.throwIfAborted();
      const params = new URLSearchParams({ region: String(regionId || '') });
      const response = await fetchImpl(`/api/live-ops/headlines?${params}`, {
        cache: 'no-store',
        signal,
      });
      if (!response.ok)
        throw new Error(`Headlines unavailable (HTTP ${response.status})`);
      const payload = await readResponseJsonCapped(
        response,
        2 * 1024 * 1024,
        signal,
      );
      signal?.throwIfAborted();
      if (
        !payload ||
        typeof payload !== 'object' ||
        !Array.isArray(payload.articles)
      )
        throw new Error(msg('Malformed headlines'));
      return {
        status: typeof payload.status === 'string' ? payload.status : 'ready',
        region: typeof payload.region === 'string' ? payload.region : null,
        name: typeof payload.name === 'string' ? payload.name : null,
        query: typeof payload.query === 'string' ? payload.query : null,
        source: typeof payload.source === 'string' ? payload.source : null,
        retrievedAt:
          typeof payload.retrievedAt === 'string' ? payload.retrievedAt : null,
        articles: normalizeRegionalArticles(
          {
            articles: payload.articles.map((article) => ({
              url: article?.url,
              title: article?.title,
              domain: article?.domain,
              seendate: article?.publishedAt,
              sourcecountry: article?.sourceCountry,
            })),
          },
          10,
        ),
      };
    },
  };
}
