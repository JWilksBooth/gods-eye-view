/**
 * Helpers the live-stream sources share: a bounded upstream read that never
 * surfaces upstream error text, and the search radius of a LIVE OPS region.
 */
import { readResponseJsonCapped } from '../common/http.js';
import { greatCircleKm } from '../../../src/geoDistance.js';

export const STREAMS_USER_AGENT = 'gods-eye-view-streams/1.0';
export const STREAMS_FETCH_TIMEOUT_MS = 15_000;
export const STREAMS_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * One bounded upstream JSON read: fixed deadline over headers and body, no
 * redirects, byte cap, and the body released on every path that will not
 * read it. A non-2xx answer throws an error that carries only the status,
 * never the upstream body, so nothing a provider says reaches a client.
 */
export async function fetchStreamsUpstream(
  url,
  {
    fetchImpl = (...args) => globalThis.fetch(...args),
    headers = {},
    timeoutMs = STREAMS_FETCH_TIMEOUT_MS,
    maxBytes = STREAMS_MAX_RESPONSE_BYTES,
    signal = null,
  } = {},
) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const response = await fetchImpl(url, {
    headers: {
      'User-Agent': STREAMS_USER_AGENT,
      Accept: 'application/json',
      ...headers,
    },
    redirect: 'error',
    signal: combined,
  });
  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      /* no-op */
    }
    throw Object.assign(new Error(`HTTP ${response.status}`), {
      status: response.status,
    });
  }
  return readResponseJsonCapped(response, maxBytes, combined);
}

/**
 * The radius that covers a region's box from its centre, in whole
 * kilometres, bounded to what the discovery APIs accept.
 */
export function regionRadiusKm(region, { min = 10, max = 1000 } = {}) {
  const [west, south, east, north] = region.bbox;
  const corners = [
    { lat: north, lon: east },
    { lat: north, lon: west },
    { lat: south, lon: east },
    { lat: south, lon: west },
  ];
  const farthest = Math.max(
    ...corners.map((corner) => greatCircleKm(region.center, corner)),
  );
  const km = Number.isFinite(farthest) ? Math.ceil(farthest) : min;
  return Math.max(min, Math.min(max, km));
}

/** `YYYY-MM-DD` of an instant in UTC, the day a quota bucket belongs to. */
export function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
