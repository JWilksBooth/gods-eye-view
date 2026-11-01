import { coalesceProxyRequest } from '../common/http.js';
import { upstreamErrorCode } from './http.js';

/**
 * Request governor for one upstream feed, so an open tab never hammers a
 * public API however many times it polls:
 *
 *  - a TTL cache: inside the interval every caller gets the same copy and
 *    upstream is not asked;
 *  - single flight: concurrent misses share one upstream request;
 *  - an hourly budget: at most `budgetPerHour` upstream attempts in any
 *    rolling hour, whatever the TTL and however many callers;
 *  - a cooldown ladder after failures (one minute, doubling, capped) so a
 *    feed that is down is not re-asked on every poll;
 *  - serve-stale: while upstream is unreachable, out of budget or cooling
 *    down, the last copy is served marked stale for up to `staleMaxMs`, and
 *    after that the feed is reported unavailable rather than invented.
 *
 * `acquire` resolves to `{ value, fetchedAt, stale, status }`; `status` is
 * `ok`, `stale` (serving an old copy after a failure), `budget` or
 * `cooldown` (an old copy because upstream was deliberately not asked).
 * Without any copy to fall back on it rejects with an error whose `code` is
 * the short failure identifier (`upstreamErrorCode`), never upstream text.
 */
export function createFeedGovernor({
  id,
  ttlMs,
  staleMaxMs = 60 * 60_000,
  budgetPerHour = 60,
  cooldownMs = 60_000,
  maxCooldownMs = 15 * 60_000,
  now = () => Date.now(),
}) {
  if (!id) throw new TypeError('A feed governor needs an id');
  if (!Number.isFinite(ttlMs) || ttlMs <= 0)
    throw new TypeError(`${id}: ttlMs must be a positive number`);
  let cache = null;
  let attempts = [];
  let failures = 0;
  let retryAt = -Infinity;
  let lastError = null;
  let lastStatus = 'idle';
  const inFlight = new Map();

  const HOUR = 60 * 60_000;
  function pruneAttempts(at) {
    attempts = attempts.filter((time) => at - time < HOUR);
  }
  function result(entry, status) {
    lastStatus = status;
    return {
      value: entry.value,
      fetchedAt: entry.fetchedAt,
      stale: status !== 'ok',
      status,
    };
  }
  function fallback(status) {
    const at = now();
    if (cache && at - cache.fetchedAt <= staleMaxMs)
      return result(cache, status);
    lastStatus = 'unavailable';
    const failure = new Error(lastError || 'unavailable');
    failure.code = lastError || (status === 'stale' ? 'unavailable' : status);
    failure.reason = status;
    throw failure;
  }

  return {
    id,
    ttlMs,
    /**
     * The feed's current copy, refreshing it through `load()` when the TTL,
     * budget and cooldown allow.
     * @param {() => Promise<*>} load
     */
    async acquire(load) {
      const at = now();
      if (cache && at - cache.fetchedAt < ttlMs) return result(cache, 'ok');
      if (at < retryAt) return fallback('cooldown');
      pruneAttempts(at);
      if (attempts.length >= budgetPerHour) return fallback('budget');
      const { promise } = coalesceProxyRequest(inFlight, id, async () => {
        attempts.push(now());
        try {
          const value = await load();
          cache = { value, fetchedAt: now() };
          failures = 0;
          retryAt = -Infinity;
          lastError = null;
          return cache;
        } catch (error) {
          failures += 1;
          lastError = upstreamErrorCode(error);
          retryAt =
            now() + Math.min(maxCooldownMs, cooldownMs * 2 ** (failures - 1));
          throw error;
        }
      });
      try {
        return result(await promise, 'ok');
      } catch {
        return fallback('stale');
      }
    },
    /** The short code of the last failure, or null after a success. */
    lastErrorCode() {
      return lastError;
    },
    /** Diagnostics without data: when, how often and how it last went. */
    describe() {
      const at = now();
      pruneAttempts(at);
      return {
        id,
        ttlMs,
        status: lastStatus,
        fetchedAt: cache ? new Date(cache.fetchedAt).toISOString() : null,
        ageMs: cache ? at - cache.fetchedAt : null,
        attemptsLastHour: attempts.length,
        budgetPerHour,
        failures,
        retryInMs: retryAt > at ? retryAt - at : 0,
        lastError,
      };
    },
    /** Drop the copy, for tests and operators. */
    reset() {
      cache = null;
      attempts = [];
      failures = 0;
      retryAt = -Infinity;
      lastError = null;
      lastStatus = 'idle';
    },
  };
}
