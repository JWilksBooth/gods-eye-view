import { readResponseJsonCapped } from '../../sources/httpBody.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel shows them translated.
const msg = (text) => text;

const ALERTS_URL = '/api/alerts';
const AIRPORTS_URL = '/api/alerts/airports';
/** A full regional payload is a few hundred kilobytes; past this it is not one. */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/**
 * Request official alerts through the bounded, same-origin `/api/alerts`
 * proxy. The proxy assembles and governs every feed; this source only names
 * what to narrow to and validates the answer's shape, so a malformed answer
 * is refused rather than drawn empty.
 */
export function createAlertsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  async function getJson(url, signal) {
    signal?.throwIfAborted();
    const response = await fetchImpl(url, {
      cache: 'no-store',
      signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      const limited = response.status === 429;
      throw Object.assign(
        new Error(
          limited
            ? msg('Alerts feed rate limited (HTTP 429)')
            : `Alerts feed unavailable (HTTP ${response.status})`,
        ),
        {
          status: response.status,
          retryable: limited || response.status >= 500,
          retryAfterMs: limited ? 60_000 : null,
        },
      );
    }
    const payload = await readResponseJsonCapped(
      response,
      MAX_RESPONSE_BYTES,
      signal,
    );
    signal?.throwIfAborted();
    return payload;
  }
  return {
    /**
     * Every current alert, optionally narrowed to one LIVE OPS region, some
     * kinds or a minimum severity, with each feed's state.
     * @returns {Promise<{alerts: object[], sources: object[], regions: object[], region: string|null, fetchedAt: string|null, stale: boolean}>}
     */
    async getSnapshot({
      signal,
      region = null,
      kinds = null,
      minSeverity = null,
    } = {}) {
      const params = new URLSearchParams();
      if (region) params.set('region', String(region));
      if (Array.isArray(kinds) && kinds.length)
        params.set('kind', kinds.join(','));
      if (minSeverity) params.set('severity', String(minSeverity));
      const query = params.size ? `?${params}` : '';
      const payload = await getJson(`${ALERTS_URL}${query}`, signal);
      if (!Array.isArray(payload?.alerts) || !Array.isArray(payload?.sources))
        throw new Error(msg('Malformed alerts snapshot'));
      return {
        alerts: payload.alerts.filter(
          (alert) => alert && typeof alert === 'object' && alert.id,
        ),
        sources: payload.sources,
        regions: Array.isArray(payload.regions) ? payload.regions : [],
        region: typeof payload.region === 'string' ? payload.region : null,
        fetchedAt:
          typeof payload.fetchedAt === 'string' ? payload.fetchedAt : null,
        stale: payload.stale === true,
      };
    },
    /**
     * FAA airport status: the regions' airports (each `normal` or its worst
     * program) and every airport the FAA lists with a closure, stop or delay.
     */
    async getAirports({ signal } = {}) {
      const payload = await getJson(AIRPORTS_URL, signal);
      if (!Array.isArray(payload?.airports) || !Array.isArray(payload?.events))
        throw new Error(msg('Malformed airport status'));
      return payload;
    },
  };
}
