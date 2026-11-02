/**
 * The CAMERAS quick panel's model: which cameras the panel lists for a view,
 * in what order, how a search narrows them and how its keyboard behaves.
 * Pure: no DOM, no Cesium, no catalogs, so the panel's policy is unit-tested
 * without a browser. The panel (cameraQuickControls.js) renders what this
 * returns; the camera wall (cameraWall.js) takes the same ranked entries.
 */
import { greatCircleKm } from '../geoDistance.js';
import { regionContains } from '../data/liveOpsRegions.js';
import { isVideoFeedType } from '../sources/cctvTypes.js';

/** Rows the panel lists: the nearest cameras, enough to scan without paging. */
export const CAMERA_QUICK_LIST_LIMIT = 24;

/**
 * `newest`: live feeds first, then stills by the age of their last frame,
 * then cameras with no frame yet, nearest first within each. `nearest`:
 * distance to the view centre alone.
 */
export const CAMERA_QUICK_ORDERS = Object.freeze(['newest', 'nearest']);
export const DEFAULT_CAMERA_QUICK_ORDER = 'newest';

const haystacks = new WeakMap();

/** Lower-case, accent-folded text for matching. */
function fold(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

/**
 * Search tokens from a typed query: whitespace-separated, folded. Every token
 * must match, so "bay bridge" finds "Bay Bridge" and "101 petaluma" narrows
 * US-101 to one stretch.
 * @param {string} text
 * @returns {string[]}
 */
export function normalizeCameraQuery(text) {
  return fold(text)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

/** The text a camera is searched by: its name, city and provider. */
function haystackOf(camera) {
  if (!camera || typeof camera !== 'object') return '';
  let text = haystacks.get(camera);
  if (text === undefined) {
    text = fold(
      [camera.name, camera.city, camera.provider].filter(Boolean).join(' '),
    );
    haystacks.set(camera, text);
  }
  return text;
}

/**
 * Whether a camera's name, city or provider contains every token. "101"
 * matches "US-101", "Hwy 101" and "SR-101"; "strip" matches "Las Vegas
 * Strip". An empty token list matches everything.
 * @param {{name?: string, city?: string, provider?: string}} camera
 * @param {string[]} tokens From normalizeCameraQuery.
 * @returns {boolean}
 */
export function cameraMatchesQuery(camera, tokens) {
  if (!tokens?.length) return true;
  const text = haystackOf(camera);
  return tokens.every((token) => text.includes(token));
}

/** Whether a catalog entry carries moving pictures (HLS, MP4, WebM, MJPEG). */
export function cameraIsLive(camera) {
  if (camera?.isVideo === true) return true;
  const feedType = String(camera?.feedType || '').toLowerCase();
  return isVideoFeedType(feedType) || feedType === 'mjpeg';
}

function byDistance(a, b) {
  if (a.distanceKm !== b.distanceKm) return a.distanceKm - b.distanceKm;
  return String(a.camera.id).localeCompare(String(b.camera.id));
}

function byNewest(a, b) {
  if (a.live !== b.live) return a.live ? -1 : 1;
  if (a.frameStamp !== b.frameStamp) return b.frameStamp - a.frameStamp;
  return byDistance(a, b);
}

/**
 * The rows the panel lists.
 *
 * Candidates are the catalog narrowed by the region box and the query; the
 * `limit` nearest to `center` are kept, so the set is always the nearest
 * cameras whatever the order. `newest` then sorts that set by the age of the
 * frames `frames` holds (`Map<id, {stamp}>`, the panel's thumbnail slots):
 * live feeds first, since they are continuously new, then the freshest
 * stills, then cameras with no frame yet; `nearest` keeps distance order.
 * Without a centre, every distance is infinite and catalog order breaks ties.
 *
 * @param {object} options
 * @param {Array<object>} options.cameras Catalog entries (`id`, `name`,
 *   `city`, `provider`, `lat`, `lon`, `feedType`, `isVideo`).
 * @param {{lat: number, lon: number}|null} [options.center]
 * @param {string} [options.query]
 * @param {{bbox: number[]}|null} [options.region] A LIVE OPS region, or null.
 * @param {'newest'|'nearest'} [options.order]
 * @param {number} [options.limit]
 * @param {Map<string, {stamp?: number}>|null} [options.frames]
 * @returns {Array<{camera: object, distanceKm: number, live: boolean, frameStamp: number}>}
 */
export function rankQuickCameras({
  cameras,
  center = null,
  query = '',
  region = null,
  order = DEFAULT_CAMERA_QUICK_ORDER,
  limit = CAMERA_QUICK_LIST_LIMIT,
  frames = null,
} = {}) {
  const tokens = normalizeCameraQuery(query);
  const hasCenter =
    Number.isFinite(center?.lat) && Number.isFinite(center?.lon);
  const entries = [];
  for (const camera of Array.isArray(cameras) ? cameras : []) {
    if (!camera || !Number.isFinite(camera.lat) || !Number.isFinite(camera.lon))
      continue;
    if (region && !regionContains(region, camera)) continue;
    if (tokens.length && !cameraMatchesQuery(camera, tokens)) continue;
    const stamp = Number(frames?.get?.(camera.id)?.stamp);
    entries.push({
      camera,
      distanceKm: hasCenter ? greatCircleKm(center, camera) : Infinity,
      live: cameraIsLive(camera),
      frameStamp: Number.isFinite(stamp) && stamp > 0 ? stamp : 0,
    });
  }
  const total = entries.length;
  entries.sort(byDistance);
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : total;
  const nearest = entries.slice(0, max);
  if (order === 'newest') nearest.sort(byNewest);
  nearest.total = total;
  return nearest;
}

/**
 * What a key does in the list: arrows move the highlighted row, Home/End
 * jump, Enter opens the highlighted row (or the first result when none is
 * highlighted, so typing a road and pressing Enter reaches a camera),
 * Escape clears a search before it closes the panel. Null for other keys.
 * @param {string} key `KeyboardEvent.key`.
 * @param {{index?: number, count?: number, hasQuery?: boolean}} [state]
 * @returns {{type: 'move'|'open', index: number}|{type: 'clear'|'close'}|null}
 */
export function quickListKeyAction(
  key,
  { index = -1, count = 0, hasQuery = false } = {},
) {
  const rows = Math.max(0, Math.floor(count) || 0);
  const last = rows - 1;
  switch (key) {
    case 'ArrowDown':
      return rows ? { type: 'move', index: Math.min(last, index + 1) } : null;
    case 'ArrowUp':
      return rows ? { type: 'move', index: Math.max(0, index - 1) } : null;
    case 'Home':
      return rows ? { type: 'move', index: 0 } : null;
    case 'End':
      return rows ? { type: 'move', index: last } : null;
    case 'Enter':
      if (!rows) return null;
      return { type: 'open', index: index >= 0 && index <= last ? index : 0 };
    case 'Escape':
      return { type: hasQuery ? 'clear' : 'close' };
    default:
      return null;
  }
}

/**
 * A distance for a row: metres under a kilometre, one decimal under ten.
 * @param {number} km
 * @returns {{value: string, unit: 'm'|'km'}|null} Null when unknown.
 */
export function cameraDistanceParts(km) {
  if (!Number.isFinite(km) || km < 0) return null;
  if (km < 0.95) {
    const metres = Math.max(10, Math.round((km * 1000) / 10) * 10);
    return { value: String(metres), unit: 'm' };
  }
  if (km < 10) return { value: km.toFixed(1), unit: 'km' };
  return { value: String(Math.round(km)), unit: 'km' };
}
