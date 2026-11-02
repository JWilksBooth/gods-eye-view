/**
 * The camera wall: a modal grid of 4, 6 or 9 camera tiles for the quick
 * panel's current list (a region or a search). Every tile is a snapshot
 * refreshed on its provider's cadence; a live tile upgrades to video while
 * hovered or when clicked (pinned), inside the camera proxy's session budget
 * (cameraWallModel.js). One click, GLOBE, or Escape returns to the globe;
 * OPEN ON GLOBE on a tile activates that camera through the application's
 * usual path and closes the wall.
 *
 * Video goes through the same HLS proxy and client playback as the CCTV
 * layer (`/api/cctv/media/<id>?lease=…`, src/layers/cctv/videoPlayback.js),
 * each tile with its own lease. Nothing here runs per frame: `<video>`
 * elements decode on their own, snapshots are `<img>` elements on a timer.
 *
 * @param {object} options
 * @param {Document} [options.documentRef]
 * @param {object} options.cctv The CCTV layer (getFrameUrl, getMediaUrl,
 *   getUIState, subscribe).
 * @param {{openOnGlobe?: (cameraId: string) => *}} [options.actions]
 * @param {number} [options.limit] Proxy session limit.
 * @param {() => number} [options.now]
 * @param {object} [options.timers] setTimeout/setInterval owner.
 * @param {Function} [options.attachVideo] Playback factory (test seam).
 * @param {(open: boolean) => void} [options.onOpenChange]
 */
import { t, tn } from '../i18n/index.js';
import { staticFrameRefreshMs } from '../data/cctvLod.js';
import {
  applyFrameResult,
  createFrameSlot,
  frameFetchDue,
} from '../data/cctvCards.js';
import { attachCctvVideo } from '../layers/cctv/videoPlayback.js';
import { isVideoFeedType } from '../sources/cctvTypes.js';
import { CCTV_HLS_SESSION_LIMIT } from '../sources/cctvStreamBudget.js';
import {
  CAMERA_WALL_SIZES,
  DEFAULT_CAMERA_WALL_SIZE,
  normalizeWallSize,
  planWallVideo,
  wallColumns,
  wallLiveCapacity,
} from './cameraWallModel.js';
import { cameraDistanceParts } from './cameraQuickModel.js';
import { createSegmentedControl } from './segmentedControl.js';

export const CAMERA_WALL_ID = 'camera-wall';
/** A hovered live tile starts video after this long, and keeps it this long after the pointer leaves. */
export const WALL_HOVER_DELAY_MS = 350;
export const WALL_HOVER_GRACE_MS = 1500;
/** A camera the proxy refused is not asked again for this long. */
export const WALL_REFUSED_MS = 20_000;
/** A live camera's still, while it is not playing. */
export const WALL_LIVE_STILL_REFRESH_MS = 30_000;
export const WALL_SNAPSHOT_TICK_MS = 5_000;
export const WALL_SNAPSHOT_IN_FLIGHT_MAX = 2;

const CONCEALING_BODY_CLASSES = ['ui-clean-view', 'recording-mode'];

export function createCameraWall({
  documentRef = globalThis.document,
  cctv,
  actions = {},
  limit = CCTV_HLS_SESSION_LIMIT,
  now = () => Date.now(),
  timers = globalThis,
  attachVideo = attachCctvVideo,
  onOpenChange = () => {},
} = {}) {
  let dialog = null;
  let nodes = null;
  let sizes = null;
  let entries = [];
  let size = DEFAULT_CAMERA_WALL_SIZE;
  let pinned = [];
  let hover = null;
  let hoverTimer = null;
  let leaveTimer = null;
  let externalId = null;
  let paused = false;
  let destroyed = false;
  let unsubscribeCctv = null;
  let snapshotTimer = null;
  let returnFocus = null;
  let bodyObserver = null;
  let lastPlan = null;
  /** @type {Map<string, object>} camera id → tile nodes */
  const tiles = new Map();
  /** @type {Map<string, {dispose: Function}>} */
  const players = new Map();
  /** @type {Map<string, number>} camera id → not before */
  const refused = new Map();
  const slots = new Map();
  const inFlight = new Set();
  const listeners = new AbortController();
  const listen = (target, type, handler, options = {}) =>
    target?.addEventListener?.(type, handler, {
      ...options,
      signal: listeners.signal,
    });
  const setText = (node, value) => {
    if (node && node.textContent !== value) node.textContent = value;
  };

  const entryOf = (id) => entries.find((entry) => entry.camera.id === id);
  const canPlay = (entry) =>
    Boolean(entry) &&
    isVideoFeedType(String(entry.camera?.feedType || '').toLowerCase());
  const refusedIds = () => {
    const at = now();
    for (const [id, until] of refused) if (until <= at) refused.delete(id);
    return [...refused.keys()];
  };
  const readExternal = (state = cctv?.getUIState?.()) =>
    state?.enabled && state.activeCamera?.isVideo
      ? state.activeCameraId || null
      : null;

  function ensure() {
    if (dialog) return dialog;
    const doc = documentRef;
    dialog = doc.createElement('dialog');
    dialog.id = CAMERA_WALL_ID;
    dialog.className = 'camera-wall';
    dialog.setAttribute('data-panel-surface', '');
    dialog.setAttribute('aria-label', t('Camera wall'));
    const header = doc.createElement('header');
    header.className = 'camera-wall-header';
    header.setAttribute('data-panel-header', '');
    const title = doc.createElement('h2');
    title.className = 'panel-title panel-surface-title camera-wall-title';
    title.textContent = t('CAMERA WALL');
    const context = doc.createElement('span');
    context.className = 'camera-wall-context';
    const sizeGroup = doc.createElement('div');
    sizeGroup.className = 'gev-segmented camera-wall-sizes';
    sizeGroup.setAttribute('role', 'radiogroup');
    sizeGroup.setAttribute('aria-label', t('Feeds shown'));
    const sizeButtons = CAMERA_WALL_SIZES.map((count) => {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'gev-segment camera-wall-size';
      button.dataset.wallSize = String(count);
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', 'false');
      button.textContent = String(count);
      button.title = tn(count, '{count} feed', '{count} feeds', { count });
      sizeGroup.appendChild(button);
      return button;
    });
    const globe = doc.createElement('button');
    globe.type = 'button';
    globe.className = 'panel-surface-control camera-wall-globe';
    globe.textContent = t('GLOBE');
    globe.title = t('Back to the globe (Esc)');
    header.append(title, context, sizeGroup, globe);
    const hint = doc.createElement('p');
    hint.className = 'camera-wall-hint';
    const grid = doc.createElement('div');
    grid.className = 'camera-wall-grid';
    grid.setAttribute('data-panel-body', '');
    dialog.append(header, hint, grid);
    doc.body.appendChild(dialog);
    nodes = { header, context, hint, grid, globe, sizeButtons };
    sizes = createSegmentedControl({
      buttons: sizeButtons,
      valueOf: (button) => Number(button.dataset.wallSize),
      onChange: (value) => setSize(value),
      keyboard: 'radio',
      listen,
    });
    listen(globe, 'click', () => close('button'));
    listen(dialog, 'cancel', (event) => {
      event.preventDefault();
      close('escape');
    });
    listen(dialog, 'click', (event) => {
      if (event.target === dialog) close('backdrop');
    });
    listen(documentRef, 'visibilitychange', () => {
      paused = Boolean(documentRef.hidden);
      if (dialog?.open) replan();
    });
    return dialog;
  }

  function createTile(entry) {
    const doc = documentRef;
    const { camera } = entry;
    const figure = doc.createElement('figure');
    figure.className = 'camera-wall-tile';
    figure.dataset.cameraId = camera.id;
    figure.tabIndex = 0;
    figure.setAttribute('role', 'group');
    // Camera names are feed data and stay as published.
    figure.setAttribute('aria-label', camera.name || camera.id);
    const img = doc.createElement('img');
    img.className = 'camera-wall-still';
    img.alt = '';
    img.decoding = 'async';
    const video = doc.createElement('video');
    video.className = 'camera-wall-video';
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.hidden = true;
    const caption = doc.createElement('figcaption');
    caption.className = 'camera-wall-caption';
    const text = doc.createElement('span');
    text.className = 'camera-wall-text';
    const name = doc.createElement('span');
    name.className = 'camera-wall-name';
    name.textContent = camera.name || camera.id;
    const meta = doc.createElement('span');
    meta.className = 'camera-wall-meta';
    const distance = cameraDistanceParts(entry.distanceKm);
    const distanceText = !distance
      ? ''
      : distance.unit === 'km'
        ? t('{distance} km', { distance: distance.value })
        : t('{distance} m', { distance: distance.value });
    meta.textContent = [camera.city, distanceText].filter(Boolean).join(' · ');
    text.append(name, meta);
    const badge = doc.createElement('span');
    badge.className = 'camera-wall-badge';
    const open = doc.createElement('button');
    open.type = 'button';
    open.className = 'panel-surface-control camera-wall-open';
    open.textContent = t('OPEN ON GLOBE');
    open.title = t('Activate this camera on the globe and close the wall');
    caption.append(text, badge, open);
    figure.append(img, video, caption);
    const tile = { figure, img, video, badge, open, entry };
    listen(open, 'click', (event) => {
      event.stopPropagation();
      openOnGlobe(camera.id);
    });
    listen(figure, 'click', () => togglePin(camera.id));
    listen(figure, 'keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (event.target !== figure) return;
      event.preventDefault();
      togglePin(camera.id);
    });
    listen(figure, 'pointerenter', (event) => {
      const pointerType = event.pointerType || 'mouse';
      if (pointerType !== 'mouse' && pointerType !== 'pen') return;
      scheduleHover(camera.id);
    });
    listen(figure, 'pointerleave', () => scheduleUnhover(camera.id));
    listen(img, 'load', () => settleSnapshot(camera.id, true));
    listen(img, 'error', () => settleSnapshot(camera.id, false));
    return tile;
  }

  function releaseTile(id, tile) {
    stopVideo(id);
    inFlight.delete(id);
    slots.delete(id);
    tile.img.removeAttribute?.('src');
    if (hover === id) hover = null;
    pinned = pinned.filter((pin) => pin !== id);
  }

  function renderTiles() {
    if (!nodes) return;
    const shown = entries.slice(0, size);
    const keep = new Set(shown.map((entry) => entry.camera.id));
    for (const [id, tile] of tiles) {
      if (keep.has(id)) continue;
      tiles.delete(id);
      releaseTile(id, tile);
    }
    const children = shown.map((entry) => {
      let tile = tiles.get(entry.camera.id);
      if (!tile) {
        tile = createTile(entry);
        tiles.set(entry.camera.id, tile);
      }
      return tile.figure;
    });
    nodes.grid.style.setProperty(
      '--camera-wall-columns',
      String(wallColumns(size)),
    );
    nodes.grid.dataset.size = String(size);
    if (!children.length) {
      const empty = documentRef.createElement('p');
      empty.className = 'camera-wall-empty';
      empty.textContent = t('No cameras to show');
      nodes.grid.replaceChildren(empty);
    } else {
      nodes.grid.replaceChildren(...children);
    }
    sizes?.update(size, { rovingFocus: true });
    replan();
    snapshotTick();
  }

  function scheduleHover(id) {
    if (leaveTimer) timers.clearTimeout(leaveTimer);
    leaveTimer = null;
    if (hover === id || !canPlay(entryOf(id))) return;
    if (hoverTimer) timers.clearTimeout(hoverTimer);
    hoverTimer = timers.setTimeout(() => {
      hoverTimer = null;
      if (destroyed || !dialog?.open) return;
      hover = id;
      replan();
    }, WALL_HOVER_DELAY_MS);
  }

  function scheduleUnhover(id) {
    if (hoverTimer) timers.clearTimeout(hoverTimer);
    hoverTimer = null;
    if (hover !== id) return;
    if (leaveTimer) timers.clearTimeout(leaveTimer);
    leaveTimer = timers.setTimeout(() => {
      leaveTimer = null;
      if (hover !== id) return;
      hover = null;
      replan();
    }, WALL_HOVER_GRACE_MS);
  }

  function togglePin(id) {
    if (!canPlay(entryOf(id))) return;
    if (pinned.includes(id)) pinned = pinned.filter((pin) => pin !== id);
    else pinned = [...pinned, id];
    replan();
  }

  function startVideo(id) {
    const tile = tiles.get(id);
    if (!tile || players.has(id) || typeof cctv?.getMediaUrl !== 'function')
      return;
    let url = null;
    try {
      url = cctv.getMediaUrl(tile.entry.camera);
    } catch {
      url = null;
    }
    if (!url) return;
    const feedType = String(tile.entry.camera.feedType || 'hls').toLowerCase();
    tile.video.hidden = false;
    const player = attachVideo(tile.video, url, feedType, {
      onFailure: () => {
        if (players.get(id) !== player) return;
        players.delete(id);
        tile.video.hidden = true;
        refused.set(id, now() + WALL_REFUSED_MS);
        pinned = pinned.filter((pin) => pin !== id);
        if (hover === id) hover = null;
        replan();
      },
    });
    players.set(id, player);
  }

  function stopVideo(id) {
    const player = players.get(id);
    if (!player) return;
    players.delete(id);
    try {
      player.dispose();
    } catch {
      /* already torn down */
    }
    const tile = tiles.get(id);
    if (tile) tile.video.hidden = true;
  }

  function tileState(id, plan) {
    const tile = tiles.get(id);
    if (!tile) return 'still';
    if (!canPlay(tile.entry)) return 'still';
    if (players.has(id)) return pinned.includes(id) ? 'pinned' : 'playing';
    if (refused.has(id)) return 'refused';
    if (plan?.hoverRefused && hover === id) return 'full';
    return 'live';
  }

  const BADGES = {
    still: () => t('STILL'),
    live: () => t('LIVE'),
    playing: () => t('LIVE'),
    pinned: () => t('LIVE · PINNED'),
    refused: () => t('LIVE UNAVAILABLE'),
    full: () => t('LIVE SLOTS FULL'),
  };

  function replan() {
    if (!nodes || destroyed) return;
    const plan = planWallVideo({
      limit,
      pinned,
      hover,
      external: externalId ? [externalId] : [],
      refused: refusedIds(),
    });
    lastPlan = plan;
    if (plan.evicted.length)
      pinned = pinned.filter((id) => !plan.evicted.includes(id));
    const want = new Set(
      paused || !dialog?.open
        ? []
        : plan.video.filter((id) => tiles.has(id) && canPlay(entryOf(id))),
    );
    for (const id of [...players.keys()]) if (!want.has(id)) stopVideo(id);
    for (const id of want) if (!players.has(id)) startVideo(id);
    for (const [id, tile] of tiles) {
      const state = tileState(id, plan);
      tile.figure.dataset.state = state;
      tile.figure.dataset.pinned = pinned.includes(id) ? 'true' : 'false';
      tile.figure.dataset.video = players.has(id) ? 'true' : 'false';
      tile.badge.dataset.state = state;
      setText(tile.badge, BADGES[state]());
      tile.figure.title = canPlay(tile.entry)
        ? t('Hover for live video · click to keep it playing')
        : t('Still camera · snapshots only');
    }
    const capacity = wallLiveCapacity({
      limit,
      external: externalId ? [externalId] : [],
      shown: [...tiles.keys()],
    });
    setText(
      nodes.hint,
      [
        t('Hover or click a live tile for video'),
        tn(
          capacity,
          '{count} live feed at a time',
          '{count} live feeds at a time',
          {
            count: capacity,
          },
        ),
      ].join(' · '),
    );
  }

  function slotFor(id) {
    let slot = slots.get(id);
    if (!slot) {
      slot = createFrameSlot();
      slots.set(id, slot);
    }
    return slot;
  }

  function snapshotTick() {
    if (destroyed || !dialog?.open || paused) return;
    if (typeof cctv?.getFrameUrl !== 'function') return;
    const at = now();
    for (const [id, tile] of tiles) {
      if (inFlight.size >= WALL_SNAPSHOT_IN_FLIGHT_MAX) break;
      if (inFlight.has(id) || players.has(id)) continue;
      const slot = slotFor(id);
      const refreshMs = canPlay(tile.entry)
        ? WALL_LIVE_STILL_REFRESH_MS
        : staticFrameRefreshMs(tile.entry.camera);
      if (!frameFetchDue(slot, refreshMs, at)) continue;
      let url = null;
      try {
        url = cctv.getFrameUrl(tile.entry.camera, refreshMs);
      } catch {
        url = null;
      }
      if (!url) continue;
      inFlight.add(id);
      slot.lastAttemptAt = at;
      tile.img.src = url;
    }
  }

  function settleSnapshot(id, ok) {
    if (destroyed) return;
    inFlight.delete(id);
    const tile = tiles.get(id);
    const slot = slotFor(id);
    Object.assign(
      slot,
      applyFrameResult(
        slot,
        { ok, frame: ok ? tile?.img || true : null },
        now(),
      ),
    );
    if (tile && ok) tile.img.dataset.ready = 'true';
    snapshotTick();
  }

  function startTimers() {
    if (snapshotTimer) return;
    snapshotTimer = timers.setInterval(snapshotTick, WALL_SNAPSHOT_TICK_MS);
    snapshotTimer?.unref?.();
  }

  function stopTimers() {
    if (snapshotTimer) timers.clearInterval(snapshotTimer);
    snapshotTimer = null;
    if (hoverTimer) timers.clearTimeout(hoverTimer);
    if (leaveTimer) timers.clearTimeout(leaveTimer);
    hoverTimer = null;
    leaveTimer = null;
  }

  function watchConcealment() {
    const body = documentRef.body;
    if (bodyObserver || typeof MutationObserver !== 'function' || !body) return;
    bodyObserver = new MutationObserver(() => {
      if (!dialog?.open) return;
      if (CONCEALING_BODY_CLASSES.some((name) => body.classList.contains(name)))
        close('concealed');
    });
    bodyObserver.observe(body, {
      attributes: true,
      attributeFilter: ['class'],
    });
  }

  function openOnGlobe(id) {
    try {
      actions.openOnGlobe?.(id);
    } catch (error) {
      console.warn('[CameraWall] open on globe failed:', error);
    }
    close('globe');
  }

  /** Show the wall for these ranked rows (cameraQuickModel entries). */
  function open({ entries: rows = [], label = '', size: wanted } = {}) {
    if (destroyed) return false;
    ensure();
    entries = (Array.isArray(rows) ? rows : []).filter(
      (entry) => entry?.camera?.id,
    );
    size = normalizeWallSize(wanted ?? size);
    pinned = [];
    hover = null;
    paused = Boolean(documentRef.hidden);
    externalId = readExternal();
    setText(nodes.context, label || '');
    returnFocus = documentRef.activeElement || null;
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    renderTiles();
    startTimers();
    watchConcealment();
    unsubscribeCctv?.();
    unsubscribeCctv =
      cctv?.subscribe?.((state) => {
        const next = readExternal(state);
        if (next === externalId) return;
        externalId = next;
        if (dialog?.open) replan();
      }) || null;
    onOpenChange(true);
    return true;
  }

  function close(reason = 'close') {
    if (!dialog?.open) return false;
    stopTimers();
    for (const id of [...players.keys()]) stopVideo(id);
    unsubscribeCctv?.();
    unsubscribeCctv = null;
    pinned = [];
    hover = null;
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
    const focus = returnFocus;
    returnFocus = null;
    if (focus && reason !== 'globe' && documentRef.body?.contains?.(focus))
      focus.focus?.({ preventScroll: true });
    onOpenChange(false);
    return true;
  }

  function setSize(value) {
    const next = normalizeWallSize(value);
    if (next === size && nodes?.grid.dataset.size === String(next)) return;
    size = next;
    if (dialog?.open) renderTiles();
  }

  function destroy() {
    if (destroyed) return;
    close('destroy');
    destroyed = true;
    listeners.abort();
    sizes?.destroy();
    bodyObserver?.disconnect();
    bodyObserver = null;
    for (const [id, tile] of tiles) releaseTile(id, tile);
    tiles.clear();
    dialog?.remove?.();
    dialog = null;
    nodes = null;
  }

  return {
    open,
    close,
    setSize,
    destroy,
    get isOpen() {
      return Boolean(dialog?.open);
    },
    get size() {
      return size;
    },
    get dialog() {
      return dialog;
    },
    /** The last video plan and the playing ids, for tests and QA. */
    readState: () => ({
      plan: lastPlan,
      playing: [...players.keys()],
      pinned: [...pinned],
      hover,
      externalId,
    }),
  };
}
