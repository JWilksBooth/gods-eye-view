/**
 * The CAMERAS quick panel body: the cameras nearest the view centre with a
 * thumbnail, name, distance and a LIVE/STILL badge, a search box that narrows
 * them by road or place, and arrow-key navigation. Opening a row goes through
 * the application's existing camera activation and flight, so the CCTV panel
 * and its single video decoder show the camera as a globe click would.
 *
 * The panel chrome (collapse, rail layout, persistence) belongs to the
 * application shell; this class owns only the body's DOM, its listeners and
 * timers, and releases them in destroy(). Thumbnails are paced: at most two
 * frame requests in flight, each row refreshed on its provider's cadence,
 * nothing per frame, and nothing while the panel is collapsed or the page is
 * hidden. The LIVE badge means the proxy saw the stream answer
 * (`cctv.getStreamHealth()`, refreshed by the layer's health poll); streams
 * nobody has checked read LIVE? and are sent to the proxy for one bounded
 * probe (`cctv.probeStreams(ids)`) a moment after they are listed.
 *
 * Actions, supplied by the shell:
 * - `isEnabled()`: whether the CCTV layer is on.
 * - `enableLayer()`: turn the CCTV layer on without a flight.
 * - `openCamera(cameraId)`: activate the camera and fly to it; resolves
 *   false when navigation was refused.
 * - `readViewCenter()`: the middle of the visible ground, or null.
 * - `subscribeViewSettled(listener)`: called when the camera stops moving;
 *   returns an unsubscribe function.
 * - `setPanelCollapsed(panelId, collapsed, options)`: panel disclosure.
 * - `openWall({ entries, label })`: show the camera wall for these rows.
 */
import { msg, t, tn } from '../i18n/index.js';
import { staticFrameRefreshMs } from '../data/cctvLod.js';
import {
  applyFrameResult,
  createFrameSlot,
  frameFetchDue,
} from '../data/cctvCards.js';
import {
  CAMERA_QUICK_ORDERS,
  DEFAULT_CAMERA_QUICK_ORDER,
  cameraDistanceParts,
  quickListKeyAction,
  rankQuickCameras,
} from './cameraQuickModel.js';
import { createSegmentedControl } from './segmentedControl.js';

export const CAMERA_QUICK_PANEL_ID = 'camera-quick-panel';
/** A live camera's still is refreshed faster than a still camera's frame. */
export const QUICK_LIVE_THUMB_REFRESH_MS = 30_000;
/** Thumbnail pacer tick while the panel is open. */
export const QUICK_THUMB_TICK_MS = 2_000;
/** Frame requests in flight at once. */
export const QUICK_THUMB_IN_FLIGHT_MAX = 2;
/** How often the newest-first order may re-sort after thumbnails land. */
export const QUICK_RERANK_MS = 10_000;
/** Unchecked streams in the list go to the proxy for a probe after this long. */
export const QUICK_STREAM_PROBE_DELAY_MS = 1_500;
/** A camera this panel asked the proxy about is not asked about again for this long. */
export const QUICK_STREAM_PROBE_MEMORY_MS = 10 * 60_000;

/** The badge per stream state (cameraQuickModel.cameraStreamState). */
const BADGES = Object.freeze({
  ok: msg('LIVE'),
  unknown: msg('LIVE?'),
  down: msg('STREAM DOWN'),
  none: msg('STILL'),
});

const STATUS = Object.freeze({
  off: msg('Cameras are off'),
  enabling: msg('Turning cameras on…'),
  loading: msg('Loading cameras…'),
  none: msg('No cameras near this view yet'),
  noMatch: msg('No cameras match'),
});

const setText = (node, value) => {
  if (node && node.textContent !== value) node.textContent = value;
};

/** A DOM id fragment for a camera id. */
const rowKey = (cameraId) => String(cameraId).replace(/[^A-Za-z0-9_-]+/g, '_');

export class CameraQuickControls {
  constructor({
    root,
    actions,
    cctv,
    document = root?.ownerDocument ?? globalThis.document,
    now = () => Date.now(),
    timers = globalThis,
  }) {
    this.root = root;
    this.actions = actions || {};
    this.cctv = cctv || null;
    this.document = document;
    this.now = now;
    this.timers = timers;
    this.destroyed = false;
    this.listeners = new AbortController();
    this._query = '';
    this._order = DEFAULT_CAMERA_QUICK_ORDER;
    this._region = null;
    this._center = null;
    this._entries = [];
    this._activeIndex = -1;
    this._activeId = null;
    this._catalog = [];
    this._state = null;
    this._slots = new Map();
    this._rows = new Map();
    this._inFlight = new Set();
    this._stampsDirty = false;
    this._needsRefresh = true;
    this._centerDirty = true;
    this._enabling = false;
    this._unsubscribeCctv = null;
    this._unsubscribeView = null;
    this._thumbTimer = null;
    this._rerankTimer = null;
    this._streamHealth = null;
    this._probeTimer = null;
    this._probing = false;
    this._probed = new Map();
    const byId = (id) => root?.querySelector(`#${id}`) || null;
    this._elements = {
      search: byId('camera-quick-search'),
      orderNewest: byId('camera-quick-order-newest'),
      orderNearest: byId('camera-quick-order-nearest'),
      region: byId('camera-quick-region'),
      wall: byId('camera-quick-wall'),
      enable: byId('camera-quick-enable'),
      status: byId('camera-quick-status'),
      list: byId('camera-quick-list'),
    };
    this._bind();
    this._renderStatus();
    this._syncRegionChip();
    this._syncWallButton();
  }

  listen(target, type, handler, options = {}) {
    target?.addEventListener?.(type, handler, {
      ...options,
      signal: this.listeners.signal,
    });
  }

  _bind() {
    const { search, orderNewest, orderNearest, region, wall, enable } =
      this._elements;
    this.listen(search, 'input', () => this.setQuery(search.value));
    // Capture: the panel chrome's own Escape handler is bound on the same
    // panel and runs in the bubble phase; a search clears before it closes.
    this.listen(this.root, 'keydown', (event) => this._onKeydown(event), {
      capture: true,
    });
    const orderButtons = [orderNewest, orderNearest].filter(Boolean);
    if (orderButtons.length) {
      this._segmented = createSegmentedControl({
        buttons: orderButtons,
        valueOf: (button) => button.dataset.quickOrder,
        onChange: (value) => this.setOrder(value),
        keyboard: 'radio',
        listen: (target, type, handler) => this.listen(target, type, handler),
      });
      this._segmented.update(this._order, { rovingFocus: true });
    }
    this.listen(region, 'click', () => this.clearRegion());
    this.listen(wall, 'click', () => this.openWall());
    this.listen(enable, 'click', () => this._enableLayer());
    this.listen(this.document, 'visibilitychange', () => {
      if (!this.document.hidden) this._thumbTick();
    });
  }

  connect() {
    if (this.destroyed) return;
    // The centre first, so the first ranking (and its thumbnail requests)
    // starts with the nearest rows rather than catalog order. A panel the
    // chrome restored expanded before this controller existed starts its
    // timers here; later disclosure changes start and stop them.
    if (this.isExpanded()) {
      this._readCenter();
      this._startTimers();
    } else this._centerDirty = true;
    this._unsubscribeCctv?.();
    this._unsubscribeCctv =
      this.cctv?.subscribe?.((state) => this._onCctvState(state)) || null;
    this._unsubscribeView?.();
    this._unsubscribeView =
      this.actions.subscribeViewSettled?.(() => this._onViewSettled()) || null;
    this.refresh();
  }

  /** Whether the rail shows the panel body. */
  isExpanded() {
    return !this.root?.classList?.contains('collapsed');
  }

  get entries() {
    return this._entries;
  }

  get region() {
    return this._region;
  }

  get order() {
    return this._order;
  }

  get query() {
    return this._query;
  }

  /**
   * The panel chrome reports every disclosure change here. An explicit
   * expand while the camera layer is off turns it on (quietly, no flight) so
   * the list fills; a restored or layout-driven expand never does.
   */
  onDisclosure(collapsed, { explicit = false } = {}) {
    if (this.destroyed) return;
    if (collapsed) {
      this._stopTimers();
      return;
    }
    if (explicit && !this._state?.enabled && !this._catalog.length)
      this._enableLayer();
    this._startTimers();
    if (this._centerDirty) this._readCenter();
    this.refresh({ force: true });
  }

  /** LIVE OPS: list this region's cameras, nearest its centre until the view settles. */
  showRegion(region) {
    if (this.destroyed) return;
    this._region = region || null;
    this._activeId = null;
    if (this._query) this.setQuery('', { render: false });
    if (this._elements.search) this._elements.search.value = '';
    if (
      Number.isFinite(region?.center?.lat) &&
      Number.isFinite(region?.center?.lon)
    )
      this._center = { lat: region.center.lat, lon: region.center.lon };
    this.actions.setPanelCollapsed?.(CAMERA_QUICK_PANEL_ID, false, {
      explicit: true,
    });
    this._syncRegionChip();
    this.refresh({ force: true });
  }

  clearRegion() {
    if (!this._region) return;
    this._region = null;
    this._syncRegionChip();
    this.refresh({ force: true });
  }

  setQuery(text, { render = true } = {}) {
    const query = String(text ?? '');
    if (query === this._query) return;
    this._query = query;
    this._activeId = null;
    if (render) this.refresh({ force: true });
  }

  setOrder(order) {
    const next = CAMERA_QUICK_ORDERS.includes(order)
      ? order
      : DEFAULT_CAMERA_QUICK_ORDER;
    if (next === this._order) return;
    this._order = next;
    this._segmented?.update(next, { rovingFocus: true });
    this.refresh({ force: true });
  }

  _enableLayer() {
    if (this._enabling || typeof this.actions.enableLayer !== 'function')
      return;
    this._enabling = true;
    this._renderStatus();
    let result;
    try {
      result = this.actions.enableLayer();
    } catch {
      result = null;
    }
    Promise.resolve(result)
      .catch(() => {})
      .finally(() => {
        this._enabling = false;
        if (!this.destroyed) this._renderStatus();
      });
  }

  _onCctvState(state) {
    if (this.destroyed) return;
    const enabled = !!state?.enabled && (this.actions.isEnabled?.() ?? true);
    const activeCameraId = state?.activeCameraId || null;
    const previous = this._state;
    this._state = { enabled, count: Number(state?.count) || 0, activeCameraId };
    const catalog = this.cctv?.getCameraCatalog?.() || [];
    if (catalog !== this._catalog) {
      this._catalog = catalog;
      this._needsRefresh = true;
    }
    // The layer replaces the map only when a verdict changed.
    const streamHealth = this.cctv?.getStreamHealth?.() || null;
    if (streamHealth !== this._streamHealth) {
      this._streamHealth = streamHealth;
      this._needsRefresh = true;
    }
    if (
      this._needsRefresh ||
      previous?.enabled !== enabled ||
      previous?.count !== this._state.count
    ) {
      this.refresh();
    } else if (previous?.activeCameraId !== activeCameraId) {
      this._markActiveRows();
      this._renderStatus();
    }
  }

  _readCenter() {
    const center = this.actions.readViewCenter?.() || null;
    this._centerDirty = false;
    if (Number.isFinite(center?.lat) && Number.isFinite(center?.lon)) {
      this._center = { lat: center.lat, lon: center.lon };
      this._needsRefresh = true;
    }
  }

  _onViewSettled() {
    if (this.destroyed) return;
    if (!this.isExpanded()) {
      this._centerDirty = true;
      return;
    }
    this._readCenter();
    this.refresh();
  }

  /** Re-rank and re-render. Collapsed, the work waits for the next expand. */
  refresh({ force = false } = {}) {
    if (this.destroyed) return;
    if (!this.isExpanded()) {
      this._needsRefresh = true;
      return;
    }
    if (!force && !this._needsRefresh) return;
    this._needsRefresh = false;
    this._entries = rankQuickCameras({
      cameras: this._catalog,
      center: this._center,
      query: this._query,
      region: this._region,
      order: this._order,
      frames: this._slots,
      streamHealth: this._streamHealth,
      now: this.now(),
    });
    this._stampsDirty = false;
    this._render();
    this._thumbTick();
    this._scheduleStreamProbe();
  }

  _render() {
    const list = this._elements.list;
    if (!list) return;
    const nodes = [];
    const seen = new Set();
    this._entries.forEach((entry, index) => {
      const id = entry.camera.id;
      let row = this._rows.get(id);
      if (!row) {
        row = this._createRow(entry.camera);
        this._rows.set(id, row);
      }
      this._updateRow(row, entry, index);
      seen.add(id);
      nodes.push(row.li);
    });
    for (const [id, row] of this._rows) {
      if (seen.has(id)) continue;
      this._rows.delete(id);
      this._releaseRow(id, row);
    }
    list.replaceChildren(...nodes);
    const activeIndex = this._activeId
      ? this._entries.findIndex((entry) => entry.camera.id === this._activeId)
      : -1;
    this._setActiveIndex(activeIndex, { scroll: false });
    this._renderStatus();
    this._syncWallButton();
  }

  _createRow(camera) {
    const doc = this.document;
    const li = doc.createElement('li');
    li.className = 'camera-quick-row';
    li.id = `camera-quick-row-${rowKey(camera.id)}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', 'false');
    li.tabIndex = -1;
    li.dataset.cameraId = camera.id;
    const thumbWrap = doc.createElement('div');
    thumbWrap.className = 'camera-quick-thumb-wrap';
    const img = doc.createElement('img');
    img.className = 'camera-quick-thumb';
    img.alt = '';
    img.decoding = 'async';
    const badge = doc.createElement('span');
    badge.className = 'camera-quick-badge';
    thumbWrap.append(img, badge);
    const text = doc.createElement('div');
    text.className = 'camera-quick-text';
    const name = doc.createElement('span');
    name.className = 'camera-quick-name';
    const meta = doc.createElement('span');
    meta.className = 'camera-quick-meta';
    text.append(name, meta);
    li.append(thumbWrap, text);
    const row = { li, img, badge, name, meta };
    this.listen(li, 'click', () => {
      const index = this._entries.findIndex(
        (entry) => entry.camera.id === camera.id,
      );
      if (index >= 0) void this._open(index);
    });
    this.listen(img, 'load', () => this._settleThumb(camera.id, true));
    this.listen(img, 'error', () => this._settleThumb(camera.id, false));
    return row;
  }

  _updateRow(row, entry, index) {
    const { camera } = entry;
    // Camera names and cities are feed data and stay as published.
    setText(row.name, camera.name || camera.id);
    const distance = cameraDistanceParts(entry.distanceKm);
    const distanceText = !distance
      ? ''
      : distance.unit === 'km'
        ? t('{distance} km', { distance: distance.value })
        : t('{distance} m', { distance: distance.value });
    setText(row.meta, [camera.city, distanceText].filter(Boolean).join(' · '));
    setText(row.badge, t(BADGES[entry.stream] || BADGES.none));
    row.badge.dataset.live = entry.live ? 'true' : 'false';
    row.badge.dataset.stream = entry.stream;
    row.li.dataset.index = String(index);
    row.li.dataset.live = entry.live ? 'true' : 'false';
    row.li.dataset.stream = entry.stream;
    row.li.dataset.active =
      camera.id === this._state?.activeCameraId ? 'true' : 'false';
    const title = t('Open {name} on the globe', { name: camera.name });
    if (row.li.title !== title) row.li.title = title;
  }

  _releaseRow(id, row) {
    this._inFlight.delete(id);
    this._slots.delete(id);
    row.img.removeAttribute?.('src');
    row.img.dataset.ready = '';
  }

  _markActiveRows() {
    const activeId = this._state?.activeCameraId || null;
    for (const [id, row] of this._rows)
      row.li.dataset.active = id === activeId ? 'true' : 'false';
  }

  _setActiveIndex(index, { scroll = true } = {}) {
    const count = this._entries.length;
    const next = index >= 0 && index < count ? index : -1;
    this._activeIndex = next;
    this._activeId = next >= 0 ? this._entries[next].camera.id : null;
    this._entries.forEach((entry, i) => {
      const row = this._rows.get(entry.camera.id);
      row?.li.setAttribute('aria-selected', i === next ? 'true' : 'false');
    });
    const search = this._elements.search;
    if (search) {
      const row = next >= 0 ? this._rows.get(this._activeId) : null;
      if (row) search.setAttribute('aria-activedescendant', row.li.id);
      else search.removeAttribute('aria-activedescendant');
      if (row && scroll) row.li.scrollIntoView?.({ block: 'nearest' });
    }
  }

  _onKeydown(event) {
    if (this.destroyed || !this.isExpanded()) return;
    const action = quickListKeyAction(event.key, {
      index: this._activeIndex,
      count: this._entries.length,
      hasQuery: Boolean(this._query),
    });
    if (!action) return;
    if (action.type === 'move') {
      event.preventDefault();
      this._setActiveIndex(action.index);
    } else if (action.type === 'open') {
      event.preventDefault();
      void this._open(action.index);
    } else if (action.type === 'clear') {
      event.preventDefault();
      event.stopPropagation();
      if (this._elements.search) this._elements.search.value = '';
      this.setQuery('');
    }
    // 'close' bubbles on to the panel chrome, which collapses the panel.
  }

  async _open(index) {
    const entry = this._entries[index];
    if (!entry) return false;
    this._setActiveIndex(index);
    let result;
    try {
      result = await this.actions.openCamera?.(entry.camera.id, entry.camera);
    } catch {
      result = false;
    }
    return result !== false;
  }

  openWall() {
    if (this.destroyed || !this._entries.length) return;
    this.actions.openWall?.({
      entries: this._entries,
      label: this._contextLabel(),
      order: this._order,
    });
  }

  _contextLabel() {
    if (this._query) return `“${this._query}”`;
    if (this._region) return this._region.name;
    return t('Nearest cameras');
  }

  _slotFor(id) {
    let slot = this._slots.get(id);
    if (!slot) {
      slot = createFrameSlot();
      this._slots.set(id, slot);
    }
    return slot;
  }

  _refreshMsFor(entry) {
    return entry.live
      ? QUICK_LIVE_THUMB_REFRESH_MS
      : staticFrameRefreshMs(entry.camera);
  }

  /** Launch due thumbnail fetches, bounded, nearest row first. */
  _thumbTick() {
    if (this.destroyed || !this.isExpanded() || this.document?.hidden) return;
    if (typeof this.cctv?.getFrameUrl !== 'function') return;
    const now = this.now();
    for (const entry of this._entries) {
      if (this._inFlight.size >= QUICK_THUMB_IN_FLIGHT_MAX) break;
      const id = entry.camera.id;
      if (this._inFlight.has(id)) continue;
      const row = this._rows.get(id);
      if (!row) continue;
      const slot = this._slotFor(id);
      const refreshMs = this._refreshMsFor(entry);
      if (!frameFetchDue(slot, refreshMs, now)) continue;
      let url = null;
      try {
        url = this.cctv.getFrameUrl(entry.camera, refreshMs);
      } catch {
        url = null;
      }
      if (!url) continue;
      this._inFlight.add(id);
      slot.lastAttemptAt = now;
      row.img.src = url;
    }
  }

  _settleThumb(id, ok) {
    if (this.destroyed) return;
    this._inFlight.delete(id);
    const row = this._rows.get(id);
    const slot = this._slotFor(id);
    Object.assign(
      slot,
      applyFrameResult(
        slot,
        { ok, frame: ok ? row?.img || true : null },
        this.now(),
      ),
    );
    if (row && ok) {
      row.img.dataset.ready = 'true';
      this._stampsDirty = true;
    }
    this._thumbTick();
  }

  /**
   * Streams in the list nobody has checked go to the proxy for a probe a
   * moment after the list settles (typing re-lists on every key), one
   * request at a time; a camera once asked about is left alone for a while
   * whatever the proxy answered. Nothing while collapsed or hidden.
   */
  _scheduleStreamProbe() {
    if (
      this.destroyed ||
      this._probeTimer ||
      typeof this.cctv?.probeStreams !== 'function'
    )
      return;
    if (!this._entries.some((entry) => entry.stream === 'unknown')) return;
    this._probeTimer = this.timers.setTimeout(() => {
      this._probeTimer = null;
      this._probeStreams();
    }, QUICK_STREAM_PROBE_DELAY_MS);
    this._probeTimer?.unref?.();
  }

  _probeStreams() {
    if (this.destroyed || !this.isExpanded() || this.document?.hidden) return;
    if (this._probing) {
      this._scheduleStreamProbe();
      return;
    }
    const now = this.now();
    for (const [id, at] of this._probed)
      if (now - at > QUICK_STREAM_PROBE_MEMORY_MS) this._probed.delete(id);
    const ids = [];
    for (const entry of this._entries) {
      const id = entry.camera.id;
      if (entry.stream !== 'unknown' || this._probed.has(id)) continue;
      this._probed.set(id, now);
      ids.push(id);
    }
    if (!ids.length) return;
    this._probing = true;
    let result;
    try {
      result = this.cctv.probeStreams(ids);
    } catch {
      result = null;
    }
    Promise.resolve(result)
      .catch(() => {})
      .finally(() => {
        this._probing = false;
      });
  }

  _startTimers() {
    if (this._thumbTimer || this.destroyed) return;
    this._thumbTimer = this.timers.setInterval(
      () => this._thumbTick(),
      QUICK_THUMB_TICK_MS,
    );
    this._thumbTimer?.unref?.();
    this._rerankTimer = this.timers.setInterval(() => {
      if (this._stampsDirty && this._order === 'newest')
        this.refresh({ force: true });
    }, QUICK_RERANK_MS);
    this._rerankTimer?.unref?.();
  }

  _stopTimers() {
    if (this._thumbTimer) this.timers.clearInterval(this._thumbTimer);
    if (this._rerankTimer) this.timers.clearInterval(this._rerankTimer);
    if (this._probeTimer) this.timers.clearTimeout(this._probeTimer);
    this._thumbTimer = null;
    this._rerankTimer = null;
    this._probeTimer = null;
  }

  _renderStatus() {
    const { status, enable } = this._elements;
    const enabled = Boolean(this._state?.enabled);
    if (enable) {
      enable.hidden =
        enabled ||
        this._enabling ||
        typeof this.actions.enableLayer !== 'function';
    }
    if (!status) return;
    let text;
    if (this._enabling) text = t(STATUS.enabling);
    else if (!this._catalog.length)
      text = enabled ? t(STATUS.loading) : t(STATUS.off);
    else if (!this._entries.length)
      text = t(this._query ? STATUS.noMatch : STATUS.none);
    else {
      const total = Number(this._entries.total) || this._entries.length;
      const parts = [];
      if (this._region) parts.push(this._region.name);
      if (this._query) parts.push(`“${this._query}”`);
      parts.push(
        tn(total, '{count} camera', '{count} cameras', { count: total }),
      );
      if (this._entries.length < total)
        parts.push(
          t('nearest {count} listed', { count: this._entries.length }),
        );
      text = parts.join(' · ');
    }
    setText(status, text);
  }

  _syncRegionChip() {
    const chip = this._elements.region;
    if (!chip) return;
    if (!this._region) {
      chip.hidden = true;
      return;
    }
    chip.hidden = false;
    setText(chip, `${this._region.name} ×`);
    chip.title = t('Show cameras everywhere');
    chip.setAttribute(
      'aria-label',
      t('Stop limiting cameras to {region}', { region: this._region.name }),
    );
  }

  _syncWallButton() {
    const button = this._elements.wall;
    if (!button) return;
    const disabled = !this._entries.length;
    if (button.disabled !== disabled) button.disabled = disabled;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._stopTimers();
    this.listeners.abort();
    this._segmented?.destroy();
    this._unsubscribeCctv?.();
    this._unsubscribeCctv = null;
    this._unsubscribeView?.();
    this._unsubscribeView = null;
    for (const [id, row] of this._rows) this._releaseRow(id, row);
    this._rows.clear();
    this._slots.clear();
    this._probed.clear();
    this._entries = [];
  }
}
