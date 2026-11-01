import { readResponseJsonCapped } from '../../sources/httpBody.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel shows them translated.
const msg = (text) => text;

const ALERTS_URL = '/api/alerts';
const AIRPORTS_URL = '/api/alerts/airports';
/** A full regional payload is a few hundred kilobytes; past this it is not one. */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/**
 * Request the normalized alert payload through the bounded, same-origin
 * alerts proxy. The proxy assembles every feed; this source only validates
 * the shape, so a malformed answer is refused rather than drawn empty.
 */
export function createAlertsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  async function getJson(url, signal, label) {
    signal?.throwIfAborted();
    const response = await fetchImpl(url, {
      signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
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
     * Every current alert in the regions, with per-feed provenance.
     * @returns {Promise<{alerts: object[], sources: object[], regions: object[], fetchedAt: string|null, stale: boolean}>}
     */
    async getSnapshot({ signal } = {}) {
      const payload = await getJson(ALERTS_URL, signal, 'Alerts');
      if (!Array.isArray(payload?.alerts) || !Array.isArray(payload?.sources))
        throw new Error(msg('Malformed alerts snapshot'));
      return {
        alerts: payload.alerts,
        sources: payload.sources,
        regions: Array.isArray(payload.regions) ? payload.regions : [],
        fetchedAt: typeof payload.fetchedAt === 'string' ? payload.fetchedAt : null,
        stale: payload.stale === true,
      };
    },
    /**
     * The FAA airport status list: every airport with an active program,
     * with coordinates for the regions' airports.
     */
    async getAirports({ signal } = {}) {
      const payload = await getJson(AIRPORTS_URL, signal, 'Airport status');
      if (!Array.isArray(payload?.airports))
        throw new Error(msg('Malformed airport status'));
      return payload;
    },
  };
}
