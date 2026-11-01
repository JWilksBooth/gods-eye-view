import * as Cesium from 'cesium';
import { msg, t } from '../../i18n/index.js';
import { liveOpsRegion } from '../../data/liveOpsRegions.js';
import {
  STREAM_KIND_LABELS,
  STREAM_OVERLAY_COHORT_LIMIT,
  STREAM_OVERLAY_COLLISION_CAPACITY,
  STREAM_OVERLAY_SOURCE_ID,
  STREAM_PLACEMENT_LABELS,
  createStreamOverlayEntry,
  mapStreamAnalystRecord,
  selectStreamOverlayCohort,
  streamAccent,
} from './model.js';
import { STREAM_KINDS } from './records.js';
export * from './model.js';
export { createStreamSource } from './source.js';
export {
  normalizeStreamSnapshot,
  STREAM_KINDS,
  STREAM_SOURCES,
  STREAM_PLACEMENTS,
} from './records.js';

/** Pick-id prefix of every point this layer draws. */
export const STREAM_PICK_PREFIX = 'stream:';
/** The event map layer whose icons replace this layer's own while it is on. */
const EVENT_MAP_LAYER_ID = 'events';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
const SELECTED_SOURCE_ID = 'streams-selected';

/** The selected stream's card: what it is, who publishes it, how it was placed. */
export function buildStreamCard(row, { interactive = false } = {}) {
  const kindLabel = t(STREAM_KIND_LABELS[row.kind] || STREAM_KIND_LABELS.link);
  const details = [kindLabel];
  if (row.owner) details.push(t('Published by {owner}', { owner: row.owner }));
  const region = row.region ? liveOpsRegion(row.region) : null;
  if (region) details.push(region.name);
  const placement = STREAM_PLACEMENT_LABELS[row.placement];
  if (placement) details.push(t(placement));
  if (row.verifiedAt)
    details.push(t('Checked on {date}', { date: row.verifiedAt }));
  if (interactive) details.push(t('Click card to open the stream'));
  return {
    id: `stream-card:${row.id}`,
    selected: true,
    interactive,
    ...(interactive
      ? { accessibilityLabel: t('Open {title}', { title: row.title }) }
      : undefined),
    title: row.title,
    details,
    accent: null,
    priority: Number.MAX_SAFE_INTEGER,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}

/**
 * Own one live-stream display: points and ambient labels for every stream
 * the proxy knows, a card on click, and the hand-off that opens a stream.
 * The layer itself never fetches media or creates a player: `openStream`
 * (the application wiring) opens the event map's feed drawer or the
 * provider's page. While the event map layer is on, its icons carry this
 * layer's streams and the points here hide, so nothing is drawn twice.
 */
export function createStreamsLayer({
  source,
  overlayHost,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
  openStream = null,
  readToken = () => '',
  now = () => Date.now(),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Live streams require a snapshot source');
  if (!overlayHost) throw new TypeError('Live streams require an overlay host');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _stale = false;
  let _partial = false;
  let _sources = [];
  let _enabled = false;
  let _clickHandler = null;
  let _selectedId = null;
  let _selectedCardId = null;
  let _region = null;
  let _kindFilter = null;
  let _dataManager = null;
  let _unsubscribeActivity = null;
  /** @type {Map<string, object>} */
  const _rows = new Map();
  /** @type {Set<(rows: object[]) => void>} */
  const _listeners = new Set();

  const canSelect = () =>
    overlayHost && screenSpaceEventHandlerFactory && picking;

  const eventMapOn = () =>
    _dataManager?.isEnabled?.(EVENT_MAP_LAYER_ID) === true;

  /** Points and labels show only while this layer alone represents its streams. */
  function syncOwnMarkers() {
    const shown = _enabled && !eventMapOn();
    if (_dataSource) _dataSource.show = shown;
    overlayHost.setVisible(STREAM_OVERLAY_SOURCE_ID, shown);
    overlayHost.setVisible?.(SELECTED_SOURCE_ID, _enabled);
  }

  function notify() {
    const rows = [..._rows.values()];
    for (const listener of _listeners) {
      try {
        listener(rows);
      } catch (error) {
        console.warn('[Streams] listener error:', error);
      }
    }
  }

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? _rows.get(_selectedId) : null;
    if (!row) {
      _selectedId = null;
      _selectedCardId = null;
      overlayHost.setEntries(SELECTED_SOURCE_ID, [], CARD_HOST_OPTIONS);
      return;
    }
    const interactive = typeof openStream === 'function';
    const card = {
      ...buildStreamCard(row, { interactive }),
      accent: streamAccent(row.kind, readToken),
      position: Cesium.Cartesian3.fromDegrees(row.lon, row.lat),
    };
    if (interactive) {
      card.activate = () => {
        openStream(row);
        return true;
      };
    }
    _selectedCardId = card.id;
    overlayHost.setEntries(SELECTED_SOURCE_ID, [card], CARD_HOST_OPTIONS);
  }

  function pickedStreamId(picked) {
    const pickId = picking.resolvePickId(picked);
    if (typeof pickId !== 'string' || !pickId.startsWith(STREAM_PICK_PREFIX))
      return null;
    const id = pickId.slice(STREAM_PICK_PREFIX.length);
    return _rows.has(id) ? id : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const cardHit = overlayHost.hitTest?.(
        click.position?.x,
        click.position?.y,
        { sourceId: SELECTED_SOURCE_ID },
      );
      if (cardHit && cardHit.entryId === _selectedCardId) {
        const row = _rows.get(_selectedId);
        if (row && typeof openStream === 'function') openStream(row);
        return;
      }
      // The event map owns clicks on its icons while it is on.
      if (eventMapOn()) return;
      const picked = _viewer.scene.pick(click.position);
      const id = picked ? pickedStreamId(picked) : null;
      if (id) {
        _selectedId = id;
        publishSelectedCard();
        return;
      }
      if (picked) {
        const pickId = picking.resolvePickId(picked);
        if (pickId && picking.isOwnedByOtherLayer(layer.id, pickId)) return;
      }
      if (_selectedId) {
        _selectedId = null;
        publishSelectedCard();
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    if (_clickHandler) {
      _clickHandler.destroy();
      _clickHandler = null;
    }
  }

  function clearOverlays() {
    _selectedId = null;
    _selectedCardId = null;
    overlayHost.clearSource(STREAM_OVERLAY_SOURCE_ID);
    overlayHost.setVisible(STREAM_OVERLAY_SOURCE_ID, false);
    overlayHost.clearSource(SELECTED_SOURCE_ID);
    overlayHost.setVisible?.(SELECTED_SOURCE_ID, false);
  }

  function render(rows) {
    const nextEntities = [];
    const overlayEntries = [];
    _rows.clear();
    for (const row of rows) {
      const position = Cesium.Cartesian3.fromDegrees(row.lon, row.lat);
      const accent = streamAccent(row.kind, readToken);
      const color = Cesium.Color.fromCssColorString(accent);
      nextEntities.push(
        new Cesium.Entity({
          id: `${STREAM_PICK_PREFIX}${row.id}`,
          position,
          point: {
            pixelSize: row.kind === 'link' ? 7 : 10,
            color: color.withAlpha(0.95),
            outlineColor: Cesium.Color.BLACK.withAlpha(0.7),
            outlineWidth: 2,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          properties: {
            streamId: row.id,
            kind: row.kind,
            source: row.source,
            region: row.region,
          },
        }),
      );
      overlayEntries.push(
        createStreamOverlayEntry({
          row,
          position,
          title: row.title.slice(0, 60),
          accent,
        }),
      );
      _rows.set(row.id, row);
    }
    _dataSource.entities.removeAll();
    for (const entity of nextEntities) _dataSource.entities.add(entity);
    if (_enabled) {
      overlayHost.setEntries(
        STREAM_OVERLAY_SOURCE_ID,
        selectStreamOverlayCohort(overlayEntries),
        {
          cohortLimit: STREAM_OVERLAY_COHORT_LIMIT,
          collisionCapacity: STREAM_OVERLAY_COLLISION_CAPACITY,
          moving: false,
        },
      );
    }
    if (_selectedId) publishSelectedCard();
    notify();
  }

  const layer = {
    id: 'streams',
    name: 'Live Streams',
    icon: '▶',
    source: 'YouTube · Caltrans · Windy · Broadcastify',
    updateInterval: 5 * 60_000,

    init(viewer) {
      if (_viewer) throw new Error('Live streams layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('streams');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _stale = false;
      _partial = false;
      _enabled = false;
      overlayHost.setVisible(STREAM_OVERLAY_SOURCE_ID, false);
      console.log('[Data:Streams] Initialized');
    },

    enable() {
      _enabled = true;
      picking?.registerPickOwner?.(
        layer.id,
        (id) =>
          _enabled &&
          typeof id === 'string' &&
          id.startsWith(STREAM_PICK_PREFIX),
      );
      syncOwnMarkers();
      installClickHandler();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      picking?.unregisterPickOwner?.(layer.id);
      if (_dataSource) _dataSource.show = false;
      removeClickHandler();
      clearOverlays();
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const snapshot =
          typeof source.getSnapshotDetail === 'function'
            ? await source.getSnapshotDetail({
                signal: request.signal,
                region: _region,
                kind: _kindFilter,
              })
            : {
                rows: await source.getSnapshot({
                  signal: request.signal,
                  region: _region,
                  kind: _kindFilter,
                }),
                sources: [],
                stale: false,
                fetchedAt: null,
              };
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        const rows = _kindFilter
          ? snapshot.rows.filter((row) => row.kind === _kindFilter)
          : snapshot.rows;
        render(rows);
        _sources = snapshot.sources;
        _stale = snapshot.stale === true;
        _partial =
          !_stale &&
          snapshot.sources.some(
            (entry) =>
              entry.ok === false &&
              entry.keyRequired !== true &&
              entry.error !== 'disabled' &&
              entry.error !== 'no_key',
          );
        _count = rows.length;
        _lastUpdate =
          _stale && Number.isFinite(snapshot.fetchedAt)
            ? snapshot.fetchedAt
            : Date.now();
        _lastError = null;
        console.log(`[Data:Streams] Updated: ${_count} streams`);
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:Streams] Fetch error:', e);
        _lastError = e?.message || msg('Live stream source unavailable');
        _stale = false;
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _unsubscribeActivity?.();
      _unsubscribeActivity = null;
      _dataManager = null;
      picking?.unregisterPickOwner?.(layer.id);
      removeClickHandler();
      clearOverlays();
      _rows.clear();
      _listeners.clear();
      _viewer = null;
      _enabled = false;
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _stale = false;
      _partial = false;
      _sources = [];
    },

    /**
     * The lifecycle manager is handed over before enable (src/app/data.js);
     * it tells this layer when the event map takes over its icons.
     */
    attachDataManager(manager) {
      _unsubscribeActivity?.();
      _dataManager = manager;
      _unsubscribeActivity =
        typeof manager?.subscribeActivity === 'function'
          ? manager.subscribeActivity((change) => {
              if (
                change?.type === 'visibility-settled' &&
                change.layerId === EVENT_MAP_LAYER_ID
              )
                syncOwnMarkers();
            })
          : null;
    },

    /** Limit the next refreshes to one LIVE OPS region (null for all) or one kind. */
    setParams({ region, kind } = {}) {
      if (region !== undefined) _region = region || null;
      if (kind !== undefined)
        _kindFilter = STREAM_KINDS.includes(kind) ? kind : null;
    },

    getParams() {
      return { region: _region, kind: _kindFilter };
    },

    /** The rows now known, in the proxy's order, for the event map and panels. */
    getRows() {
      return [..._rows.values()];
    },

    /** One row by id, or null. */
    getRow(id) {
      return _rows.get(String(id)) || null;
    },

    /** Observe row changes; the listener gets the current rows at once. */
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      _listeners.add(listener);
      listener([..._rows.values()]);
      return () => _listeners.delete(listener);
    },

    /**
     * Resolve a pick id, a row id or a title to a voice/pick descriptor
     * (src/data/pickedContext.js reads this through the pick registry).
     */
    findByQuery(query) {
      const value = String(query ?? '').trim();
      if (!value) return null;
      const id = value.startsWith(STREAM_PICK_PREFIX)
        ? value.slice(STREAM_PICK_PREFIX.length)
        : value;
      let row = _rows.get(id) || null;
      if (!row) {
        const lower = value.toLowerCase();
        for (const candidate of _rows.values()) {
          if (candidate.title.toLowerCase() === lower) {
            row = candidate;
            break;
          }
        }
      }
      if (!row) return null;
      return {
        name: row.title,
        kind: 'stream',
        id: row.id,
        pickId: `${STREAM_PICK_PREFIX}${row.id}`,
        latitude: row.lat,
        longitude: row.lon,
        source: row.owner || row.sourceLabel,
        streamKind: row.kind,
        pageUrl: row.pageUrl,
      };
    },

    /** Snapshot stream facts as plain JSON-safe objects for the analyst query engine. */
    getAnalystRecords(maxCount = 2000) {
      if (!_enabled) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const result = [];
      for (const row of _rows.values()) {
        if (result.length >= limit) break;
        result.push(mapStreamAnalystRecord(row));
      }
      return result;
    },

    getRowControls() {
      const counts = new Map();
      for (const row of _rows.values())
        counts.set(row.kind, (counts.get(row.kind) || 0) + 1);
      return {
        chips: [],
        legend: STREAM_KINDS.map((kind, index) => ({
          label: t(STREAM_KIND_LABELS[kind]),
          color: streamAccent(kind, readToken),
          count: counts.get(kind) || 0,
          ...(index === 0
            ? {
                blurb: t(
                  'Colour shows how a stream plays. Nothing loads until you open one.',
                ),
              }
            : {}),
        })),
      };
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _stale,
        partial: _partial,
        sources: _sources,
      };
    },
  };
  return layer;
}
