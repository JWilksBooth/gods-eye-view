/**
 * The camera wall's policy: how many tiles it shows and which of them may
 * play video at once. The camera proxy pulls at most
 * `CCTV_HLS_SESSION_LIMIT` distinct cameras (server/providers/cctv/stream.js),
 * and the CCTV layer's own active camera can hold one of those sessions, so
 * the wall plans every upgrade against the same budget instead of asking the
 * proxy and reading a 503. Pure: no DOM, no timers.
 */
import { CCTV_HLS_SESSION_LIMIT } from '../sources/cctvStreamBudget.js';

/** Tile counts the wall offers. */
export const CAMERA_WALL_SIZES = Object.freeze([4, 6, 9]);
export const DEFAULT_CAMERA_WALL_SIZE = 6;

/** A valid wall size, the default for anything else. */
export function normalizeWallSize(value) {
  const size = Number(value);
  return CAMERA_WALL_SIZES.includes(size) ? size : DEFAULT_CAMERA_WALL_SIZE;
}

/** Grid columns for a wall size: 2x2, 3x2, 3x3. */
export function wallColumns(size) {
  return normalizeWallSize(size) === 4 ? 2 : 3;
}

/**
 * Which tiles play video.
 *
 * Sessions are counted per distinct camera: a camera the layer already
 * streams (`external`) costs the wall nothing when the wall shows it too,
 * and one slot otherwise. Pinned tiles (clicked) come first, newest pin
 * first, so a new pin evicts the oldest when the budget is full; the hovered
 * tile takes a free slot and never evicts a pin. A camera the proxy refused
 * recently is skipped, and so is a camera whose stream the proxy knows to
 * be down (`dead`): neither a hover nor a pin spends a session on it, and a
 * pinned camera that goes down is evicted.
 *
 * @param {object} options
 * @param {number} [options.limit] Distinct cameras the proxy pulls at once.
 * @param {string[]} [options.pinned] Pinned camera ids, oldest pin first.
 * @param {string|null} [options.hover] The hovered camera id.
 * @param {string[]} [options.external] Cameras streamed outside the wall.
 * @param {string[]} [options.refused] Cameras the proxy refused recently.
 * @param {string[]} [options.dead] Cameras whose stream is known to be down.
 * @returns {{video: string[], evicted: string[], hoverRefused: boolean}}
 */
export function planWallVideo({
  limit = CCTV_HLS_SESSION_LIMIT,
  pinned = [],
  hover = null,
  external = [],
  refused = [],
  dead = [],
} = {}) {
  const budget = Math.max(0, Math.floor(Number(limit)) || 0);
  const outside = new Set((external || []).filter(Boolean));
  const blocked = new Set(
    [...(refused || []), ...(dead || [])].filter(Boolean),
  );
  const video = [];
  const used = () =>
    video.length + [...outside].filter((id) => !video.includes(id)).length;
  const admit = (id) => {
    if (!id || blocked.has(id)) return false;
    if (video.includes(id)) return true;
    const cost = outside.has(id) ? 0 : 1;
    if (used() + cost > budget) return false;
    video.push(id);
    return true;
  };
  const evicted = [];
  const pins = [...new Set((pinned || []).filter(Boolean))];
  for (let i = pins.length - 1; i >= 0; i -= 1) {
    if (!admit(pins[i])) evicted.push(pins[i]);
  }
  const hoverRefused = Boolean(hover) && !admit(hover);
  return { video, evicted: evicted.reverse(), hoverRefused };
}

/**
 * Live slots the wall can use right now: the budget less the sessions held
 * outside it by cameras the wall does not show.
 * @param {{limit?: number, external?: string[], shown?: string[]}} options
 * @returns {number}
 */
export function wallLiveCapacity({
  limit = CCTV_HLS_SESSION_LIMIT,
  external = [],
  shown = [],
} = {}) {
  const onWall = new Set(shown || []);
  const held = new Set((external || []).filter((id) => id && !onWall.has(id)))
    .size;
  return Math.max(0, (Math.floor(Number(limit)) || 0) - held);
}
