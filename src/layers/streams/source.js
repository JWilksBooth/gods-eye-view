import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { normalizeStreamSnapshot } from './records.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel shows them translated.
const msg = (text) => text;

const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

/**
 * Request live-stream metadata through the same-origin `/api/streams`
 * proxy. `region` limits the answer to one LIVE OPS region and `kind` to one
 * embed kind; omitted, every region's streams come back. This source only
 * ever reads metadata: it never requests media and never creates a player.
 */
export function createStreamSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  /**
   * The rows with how fresh they are: the proxy answers from its last
   * snapshot, marked stale, while every upstream is unreachable, and lists
   * each source's own state so a keyless or partial answer is visible.
   * @returns {Promise<{rows: object[], sources: object[], stale: boolean, fetchedAt: number|null, region: string|null}>}
   */
  async function getSnapshotDetail({ signal, region = null, kind = null } = {}) {
    signal?.throwIfAborted();
    const params = new URLSearchParams();
    if (region) params.set('region', String(region));
    if (kind) params.set('kind', String(kind));
    const query = params.size ? `?${params}` : '';
    const response = await fetchImpl(`/api/streams${query}`, {
      cache: 'no-store',
      signal,
    });
    if (!response.ok) {
      const limited = response.status === 429;
      throw Object.assign(
        new Error(
          limited
            ? msg('Live stream feed rate limited (HTTP 429)')
            : `Live stream feed unavailable (HTTP ${response.status})`,
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
    const snapshot = normalizeStreamSnapshot(payload);
    if (!snapshot) throw new Error(msg('Malformed live stream snapshot'));
    return snapshot;
  }

  return {
    /** The stream rows (see getSnapshotDetail for freshness). */
    async getSnapshot(options = {}) {
      return (await getSnapshotDetail(options)).rows;
    },
    getSnapshotDetail,
  };
}
