import { HEALTH_SYNC_INTERVAL_MS } from './policy.js';
import {
  readStreamHealth,
  sameStreamHealth,
} from '../../sources/cctvStreamHealth.js';

export function createHealth({ state: layerState, services, parts, source }) {
  /**
   * Replace the stream health map only when its content changed: the
   * CAMERAS quick panel and the camera wall compare the instance to decide
   * whether to re-rank, so a poll that learned nothing costs them nothing.
   * @param {Map<string, {ok: number, fail: number}>} next
   * @returns {boolean} Whether the map was replaced.
   */
  function applyStreamHealth(next) {
    if (sameStreamHealth(layerState._streamHealthById, next)) return false;
    layerState._streamHealthById = next;
    return true;
  }

  /**
   * Fetches per-camera health status from the backend and updates _healthById.
   * Rate-limited to HEALTH_SYNC_INTERVAL_MS unless forced.
   * @param {boolean} [force=false] - Bypass the interval check.
   */

  async function syncHealthState(force = false) {
    const now = Date.now();
    if (!force && now - layerState._lastHealthSyncAt < HEALTH_SYNC_INTERVAL_MS)
      return;
    layerState._lastHealthSyncAt = now;

    try {
      const signal = layerState._sourceAbort?.signal;
      const data = await source.getHealth({ signal });
      signal?.throwIfAborted();
      const rows = Array.isArray(data?.cameras) ? data.cameras : [];
      const next = new Map();
      for (const row of rows) {
        const id = String(row?.id || '').trim();
        if (!id) continue;
        next.set(id, {
          status: String(row.status || '').toLowerCase() || 'unknown',
          sourceKind: String(
            row.sourceKind || row.feedType || '',
          ).toLowerCase(),
          label: String(row.label || row.provider || ''),
          message: String(row.message || ''),
          updatedAt: parts.model.safeNumber(row.updatedAt, now),
        });
      }
      layerState._healthById = next;
      // What each camera's playlist last answered, when the proxy reports
      // it (an older proxy does not, and the map it last gave stands).
      if (data?.streams && typeof data.streams === 'object')
        applyStreamHealth(readStreamHealth(data.streams));
    } catch {
      // keep previous health map
    }
  }

  /**
   * Fold a probe's answer (`{ [id]: { ok, fail } }`) into the stream health
   * and tell listeners when something changed.
   * @param {unknown} streams
   * @returns {boolean}
   */
  function mergeStreamHealth(streams) {
    const incoming = readStreamHealth(streams);
    if (!incoming.size) return false;
    const next = new Map(layerState._streamHealthById);
    for (const [id, entry] of incoming) next.set(id, entry);
    const changed = applyStreamHealth(next);
    if (changed) parts.presentation.notifyListeners();
    return changed;
  }

  return { syncHealthState, mergeStreamHealth };
}
