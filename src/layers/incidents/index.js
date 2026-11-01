import * as Cesium from 'cesium';
import { msg, t, formatRelativeTime } from '../../i18n/index.js';
import {
  INCIDENT_OVERLAY_SOURCE_ID,
  INCIDENT_OVERLAY_COHORT_LIMIT,
  INCIDENT_OVERLAY_COLLISION_CAPACITY,
  INCIDENT_TYPE_LABELS,
  createIncidentOverlayEntry,
  incidentAccent,
  mapIncidentAnalystRecord,
  selectIncidentOverlayCohort,
} from './model.js';
import { INCIDENT_TYPES } from './records.js';
export * from './model.js';
export { createIncidentSource } from './source.js';
export { normalizeIncidentSnapshot, INCIDENT_TYPES } from './records.js';

const PICK_PREFIX = 'incident:';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
const SELECTED_SOURCE_ID = 'incidents-selected';

/** Minutes/hours/days ago, or null for an undated row. */
function age(row, nowMs) {
  if (!Number.isFinite(row.time)) return null;
  const delta = Math.max(0, nowMs - row.time);
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return formatRelativeTime(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 48) return formatRelativeTime(-hours, 'hour');
  return formatRelativeTime(-Math.round(hours / 24), 'day');
}

/** The selected incident's card: type, where, who reported it and when. */
export function buildIncidentCard(row, nowMs) {
  const typeLabel = t(
    INCIDENT_TYPE_LABELS[row.type] || INCIDENT_TYPE_LABELS.other,
  );
  const details = [];
  if (row.typeDetail) details.push(row.typeDetail);
  if (row.location) details.push(row.location);
  if (row.description) details.push(row.description);
  const provenance = [row.agency, row.area].filter(Boolean).join(' · ');
  if (provenance) details.push(provenance);
  const when = age(row, nowMs);
  details.push(
    when
      ? t('{source} · reported {when}', { source: row.sourceLabel, when })
      : t('{source} · time not reported', { source: row.sourceLabel }),
  );
  if (row.url) details.push(t('Click card to open the source'));
  return {
    id: `incident-card:${row.id}`,
    selected: true,
    interactive: Boolean(row.url),
    ...(row.url
      ? {
          accessibilityLabel: t('Open {title} at its source', {
            title: typeLabel,
          }),
        }
      : undefined),
    title: t('{type} · {agency}', { type: typeLabel, agency: row.agency }),
    details,
    accent: incidentAccent(row.type),
    priority: Number.MAX_SAFE_INTEGER,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}

/** Own one live-incident display, its refresh lifecycle, and click selection. */
export function createIncidentsLayer({
  source,
  overlayHost,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
  openExternal = null,
  now = () => Date.now(),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Incidents require a snapshot source');
  if (!overlayHost) throw new TypeError('Incidents require an overlay host');
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
  let _typeFilter = null;
  /** @type {Map<string, object>} */
  const _rows = new Map();

  const canSelect = () =>
    overlayHost && screenSpaceEventHandlerFactory && picking;

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? _rows.get(_selectedId) : null;
    if (!row) {
      _selectedId = null;
      _selectedCardId = null;
      overlayHost.setEntries(SELECTED_SOURCE_ID, [], CARD_HOST_OPTIONS);
      return;
    }
    const card = {
      ...buildIncidentCard(row, now()),
      position: Cesium.Cartesian3.fromDegrees(row.lon, row.lat),
    };
    if (!openExternal) card.interactive = false;
    if (row.url && openExternal) {
      const url = row.url;
      card.activate = () => {
        openExternal(url);
        return true;
      };
    }
    _selectedCardId = card.id;
    overlayHost.setEntries(SELECTED_SOURCE_ID, [card], CARD_HOST_OPTIONS);
  }

  function pickedIncidentId(picked) {
    const pickId = picking.resolvePickId(picked);
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const id = pickId.slice(PICK_PREFIX.length);
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
        if (row?.url && openExternal) openExternal(row.url);
        return;
      }
      const picked = _viewer.scene.pick(click.position);
      const id = picked ? pickedIncidentId(picked) : null;
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
    overlayHost.clearSource(INCIDENT_OVERLAY_SOURCE_ID);
    overlayHost.setVisible(INCIDENT_OVERLAY_SOURCE_ID, false);
    overlayHost.clearSource(SELECTED_SOURCE_ID);
    overlayHost.setVisible?.(SELECTED_SOURCE_ID, false);
  }

  function labelFor(row) {
    const typeLabel = t(
      INCIDENT_TYPE_LABELS[row.type] || INCIDENT_TYPE_LABELS.other,
    );
    const place = row.location || row.area;
    return place ? `${typeLabel} · ${place}`.slice(0, 60) : typeLabel;
  }

  function render(rows) {
    const nextEntities = [];
    const overlayEntries = [];
    _rows.clear();
    for (const row of rows) {
      const position = Cesium.Cartesian3.fromDegrees(row.lon, row.lat);
      const color = Cesium.Color.fromCssColorString(incidentAccent(row.type));
      nextEntities.push(
        new Cesium.Entity({
          id: `${PICK_PREFIX}${row.id}`,
          position,
          point: {
            pixelSize: 10,
            color: color.withAlpha(0.95),
            outlineColor: Cesium.Color.BLACK.withAlpha(0.7),
            outlineWidth: 2,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          properties: {
            incidentId: row.id,
            type: row.type,
            agency: row.agency,
            region: row.region,
          },
        }),
      );
      overlayEntries.push(
        createIncidentOverlayEntry({ row, position, title: labelFor(row) }),
      );
      _rows.set(row.id, row);
    }
    _dataSource.entities.removeAll();
    for (const entity of nextEntities) _dataSource.entities.add(entity);
    if (_enabled) {
      overlayHost.setEntries(
        INCIDENT_OVERLAY_SOURCE_ID,
        selectIncidentOverlayCohort(overlayEntries),
        {
          cohortLimit: INCIDENT_OVERLAY_COHORT_LIMIT,
          collisionCapacity: INCIDENT_OVERLAY_COLLISION_CAPACITY,
          moving: false,
        },
      );
    }
    if (_selectedId) publishSelectedCard();
  }

  const layer = {
    id: 'incidents',
    name: 'Live Incidents',
    icon: '🚨',
    source: 'CHP · DataSF · LAFD · CAL FIRE · NV 511',
    updateInterval: 60000,

    init(viewer) {
      if (_viewer) throw new Error('Incidents layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('incidents');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _stale = false;
      _partial = false;
      _enabled = false;
      overlayHost.setVisible(INCIDENT_OVERLAY_SOURCE_ID, false);
      console.log('[Data:Incidents] Initialized');
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(INCIDENT_OVERLAY_SOURCE_ID, true);
      overlayHost.setVisible?.(SELECTED_SOURCE_ID, true);
      installClickHandler();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
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
              })
            : {
                rows: await source.getSnapshot({
                  signal: request.signal,
                  region: _region,
                }),
                sources: [],
                stale: false,
                fetchedAt: null,
              };
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        const rows = _typeFilter
          ? snapshot.rows.filter((row) => row.type === _typeFilter)
          : snapshot.rows;
        render(rows);
        _sources = snapshot.sources;
        _stale = snapshot.stale === true;
        _partial =
          !_stale &&
          snapshot.sources.some(
            (entry) => entry.ok === false && entry.error !== 'disabled',
          );
        _count = rows.length;
        _lastUpdate =
          _stale && Number.isFinite(snapshot.fetchedAt)
            ? snapshot.fetchedAt
            : Date.now();
        _lastError = null;
        console.log(`[Data:Incidents] Updated: ${_count} incidents`);
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:Incidents] Fetch error:', e);
        _lastError = e?.message || msg('Incident source unavailable');
        _stale = false;
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      removeClickHandler();
      clearOverlays();
      _rows.clear();
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

    /** Limit the next refreshes to one LIVE OPS region (null for all) or one type. */
    setParams({ region, type } = {}) {
      if (region !== undefined) _region = region || null;
      if (type !== undefined)
        _typeFilter = INCIDENT_TYPES.includes(type) ? type : null;
    },

    getParams() {
      return { region: _region, type: _typeFilter };
    },

    /** The rows now drawn, newest first, for panels and the analyst engine. */
    getRows() {
      return [..._rows.values()];
    },

    /** Snapshot incident facts as plain JSON-safe objects for the analyst query engine. */
    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const result = [];
      for (const row of _rows.values()) {
        if (result.length >= limit) break;
        result.push(mapIncidentAnalystRecord(row));
      }
      return result;
    },

    getRowControls() {
      const counts = new Map();
      for (const row of _rows.values())
        counts.set(row.type, (counts.get(row.type) || 0) + 1);
      return {
        chips: [],
        legend: INCIDENT_TYPES.map((type, index) => ({
          label: t(INCIDENT_TYPE_LABELS[type]),
          color: incidentAccent(type),
          count: counts.get(type) || 0,
          ...(index === 0
            ? {
                blurb: t(
                  'Colour shows the incident type. Positions are as the agency reported them.',
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
