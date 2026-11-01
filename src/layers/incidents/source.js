import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { normalizeIncidentSnapshot } from './records.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel shows them translated.
const msg = (text) => text;

const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

/**
 * Request live incidents through the same-origin `/api/incidents` proxy.
 * `region` limits the answer to one LIVE OPS region; omitted, every
 * region's incidents come back.
 */
export function createIncidentSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  /**
   * The rows with how fresh they are: the proxy answers from its last
   * snapshot, marked stale, while every upstream is unreachable, and lists
   * each source's own state so a partial answer is visible.
   * @returns {Promise<{rows: object[], sources: object[], stale: boolean, fetchedAt: number|null}>}
   */
  async function getSnapshotDetail({ signal, region = null } = {}) {
    signal?.throwIfAborted();
    const params = new URLSearchParams();
    if (region) params.set('region', String(region));
    const query = params.size ? `?${params}` : '';
    const response = await fetchImpl(`/api/incidents${query}`, {
      cache: 'no-store',
      signal,
    });
    if (!response.ok) {
      const limited = response.status === 429;
      throw Object.assign(
        new Error(
          limited
            ? msg('Incident feed rate limited (HTTP 429)')
            : `Incident feed unavailable (HTTP ${response.status})`,
        ),
        {
          status: response.status,
          retryable: limited || response.status >= 500,
          retryAfterMs: limited ? 60000 : null,
        },
      );
    }
    const payload = await readResponseJsonCapped(
      response,
      MAX_SNAPSHOT_BYTES,
      signal,
    );
    signal?.throwIfAborted();
    const snapshot = normalizeIncidentSnapshot(payload);
    if (!snapshot) throw new Error(msg('Malformed incident snapshot'));
    return snapshot;
  }

  return {
    /** The incident rows (see getSnapshotDetail for freshness). */
    async getSnapshot(options = {}) {
      return (await getSnapshotDetail(options)).rows;
    },
    getSnapshotDetail,
  };
}
