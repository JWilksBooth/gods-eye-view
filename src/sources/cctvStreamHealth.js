/**
 * Stream health policy, shared by the camera proxy that records it
 * (server/providers/cctv/streamHealth.js) and the browser surfaces that rank
 * and badge cameras by it (the CAMERAS quick panel, the camera wall).
 *
 * A record is two timestamps per camera: when its playlist last answered
 * (`ok`) and when it last failed (`fail`). The proxy learns them from the
 * HLS leases it pulls and from a bounded probe of playlists; nothing is kept
 * on disk. The same two numbers travel to the browser in
 * `GET /api/cctv/health` as `streams: { [cameraId]: { ok, fail } }`.
 */

/** A failure this recent, with no success since, means the stream is down. */
export const CCTV_STREAM_FAILURE_WINDOW_MS = 10 * 60 * 1000;

/** A success this recent, with no failure since, means the stream is live. */
export const CCTV_STREAM_OK_WINDOW_MS = 60 * 60 * 1000;

/** Cameras one `GET /api/cctv/stream-probe` request may name. */
export const CCTV_STREAM_PROBE_BATCH = 24;

/**
 * What a record says now.
 *
 * `down`: the last verdict was a failure inside the failure window. `ok`:
 * the last verdict was a success inside the success window (a success at
 * the same instant as a failure counts as the later one, so a play that
 * works clears a failure). `unknown`: no verdict, or one too old to trust.
 *
 * @param {{ok?: number, fail?: number}|null|undefined} entry
 * @param {number} [now]
 * @returns {'ok'|'down'|'unknown'}
 */
export function streamHealthState(entry, now = Date.now()) {
  const ok = Number(entry?.ok) || 0;
  const fail = Number(entry?.fail) || 0;
  if (fail > 0 && fail > ok && now - fail < CCTV_STREAM_FAILURE_WINDOW_MS)
    return 'down';
  if (ok > 0 && ok >= fail && now - ok < CCTV_STREAM_OK_WINDOW_MS) return 'ok';
  return 'unknown';
}

/**
 * The `streams` object of a health response as a Map, dropping anything
 * that is not two finite timestamps.
 * @param {unknown} streams
 * @returns {Map<string, {ok: number, fail: number}>}
 */
export function readStreamHealth(streams) {
  const map = new Map();
  if (!streams || typeof streams !== 'object' || Array.isArray(streams))
    return map;
  for (const [id, value] of Object.entries(streams)) {
    const key = String(id).trim();
    if (!key || !value || typeof value !== 'object') continue;
    const ok = Number(value.ok);
    const fail = Number(value.fail);
    map.set(key, {
      ok: Number.isFinite(ok) && ok > 0 ? ok : 0,
      fail: Number.isFinite(fail) && fail > 0 ? fail : 0,
    });
  }
  return map;
}

/**
 * Whether two health maps hold the same records, so a poll that learned
 * nothing new can keep the map instance its readers compare by identity.
 * @param {Map<string, {ok: number, fail: number}>|null|undefined} a
 * @param {Map<string, {ok: number, fail: number}>|null|undefined} b
 */
export function sameStreamHealth(a, b) {
  if (a === b) return true;
  if (!a || !b || a.size !== b.size) return false;
  for (const [id, entry] of a) {
    const other = b.get(id);
    if (!other || other.ok !== entry.ok || other.fail !== entry.fail)
      return false;
  }
  return true;
}
