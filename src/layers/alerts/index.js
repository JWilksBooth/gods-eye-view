import * as Cesium from 'cesium';
import { formatNumber, msg, t, tn } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import {
  ALERTS_LAYER_ID,
  ALERT_KINDS,
  ALERT_KIND_IDS,
  ALERT_SEVERITIES,
  alertAnchor,
  alertIsCurrent,
  alertSeverity,
  compareAlerts,
  countBySeverity,
  mapAlertAnalystRecord,
  severityRank,
} from './model.js';
import { ALERT_REGIONS } from './regions.js';
import {
  ALERTS_OVERLAY_COHORT_LIMIT,
  ALERTS_OVERLAY_COLLISION_CAPACITY,
  ALERTS_OVERLAY_SOURCE_ID,
  buildAlertCard,
  buildBulletinCard,
  createAlertOverlayEntry,
  selectAlertOverlayCohort,
} from './cards.js';
export * from './model.js';
export * from './cards.js';
export * from './regions.js';
export { createAlertsSource } from './source.js';

/** A point alert is a place, not an extent. */
const MARKER_RADIUS_M = 2500;
/** The disc that gathers a region's bulletins at its anchor. */
const BULLETIN_RADIUS_M = 4000;
const CARD_SOURCE_ID = `${ALERTS_OVERLAY_SOURCE_ID}-selected`;
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
const ENTITY_PREFIX = 'alert#';
const BULLETIN_PREFIX = 'alert-bulletins#';

// Feed statuses arrive as codes from the proxy; the row shows them in words.
const SOURCE_STATUS_LABELS = Object.freeze({
  ok: msg('live'),
  stale: msg('stale copy'),
  budget: msg('stale copy'),
  cooldown: msg('stale copy'),
  unavailable: msg('unavailable'),
  'key-required': msg('key required'),
});

/**
 * The severity colours the theme paints the layer with, read from the
 * stylesheet's tokens through `resolveToken` (src/ui/styles/alerts.css).
 * Without a stylesheet (tests, a headless host) the model's fallbacks apply.
 */
export function resolveSeverityColors(resolveToken) {
  const colors = {};
  for (const band of ALERT_SEVERITIES) {
    let css = null;
    try {
      css = resolveToken?.(band.token);
    } catch {
      css = null;
    }
    const text = typeof css === 'string' ? css.trim() : '';
    colors[band.id] =
      text && Cesium.Color.fromCssColorString(text) ? text : band.fallback;
  }
  return colors;
}

const ringPositions = (ring) =>
  ring.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat));

/** Own one alerts display: its refresh lifecycle, selection and cards. */
export function createAlertsLayer({
  source,
  overlayHost,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
  openExternal = null,
  resolveToken = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Alerts require a snapshot source');
  if (!overlayHost) throw new TypeError('Alerts require an overlay host');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _enabled = false;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _stale = false;
  let _partial = false;
  let _sources = [];
  let _alerts = [];
  let _kinds = new Set(ALERT_KIND_IDS);
  let _colors = resolveSeverityColors(resolveToken);
  let _clickHandler = null;
  let _selected = null; // { alertId } | { regionId }
  let _selectedCardId = null;
  let rowControlsListener = null;
  /** @type {Map<string, object>} alert id → alert */
  const _byId = new Map();
  /** @type {Map<string, string>} entity id → alert id */
  const _entityToAlert = new Map();
  /** @type {Map<string, object[]>} region id → bulletins without geometry */
  const _bulletins = new Map();

  const notify = () => rowControlsListener?.();
  const canSelect = () =>
    Boolean(overlayHost && screenSpaceEventHandlerFactory && picking);
  const colorFor = (severity) =>
    Cesium.Color.fromCssColorString(
      _colors[alertSeverity(severity).id] || alertSeverity('unknown').fallback,
    ) || Cesium.Color.GRAY;

  function visible() {
    return _alerts.filter((alert) => _kinds.has(alert.kind));
  }

  function selectedLink() {
    if (!_selected) return null;
    if (_selected.alertId) return _byId.get(_selected.alertId)?.url || null;
    const bulletins = _bulletins.get(_selected.regionId) || [];
    const first = bulletins
      .slice()
      .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))[0];
    return first?.url || null;
  }

  function publishSelectedCard() {
    if (!canSelect()) return;
    const now = Date.now();
    let card = null;
    if (_selected?.alertId) {
      const alert = _byId.get(_selected.alertId);
      const anchor = alert && _kinds.has(alert.kind) ? alertAnchor(alert) : null;
      if (anchor)
        card = {
          ...buildAlertCard(alert, now, {
            accent: _colors[alertSeverity(alert.severity).id],
            link: openExternal ? alert.url : null,
          }),
          position: Cesium.Cartesian3.fromDegrees(anchor.lon, anchor.lat),
        };
    } else if (_selected?.regionId) {
      const region = ALERT_REGIONS.find((entry) => entry.id === _selected.regionId);
      const bulletins = _bulletins.get(_selected.regionId) || [];
      if (region && bulletins.length)
        card = {
          ...buildBulletinCard(region, bulletins, now, {
            accent: _colors[alertSeverity(bulletins[0].severity).id],
            link: openExternal ? selectedLink() : null,
          }),
          position: Cesium.Cartesian3.fromDegrees(region.anchor.lon, region.anchor.lat),
        };
    }
    if (!card) {
      _selected = null;
      _selectedCardId = null;
      overlayHost.setEntries(CARD_SOURCE_ID, [], CARD_HOST_OPTIONS);
      return;
    }
    if (!openExternal) card.interactive = false;
    const link = selectedLink();
    if (link && openExternal) {
      card.activate = () => {
        openExternal(link);
        return true;
      };
    }
    _selectedCardId = card.id;
    overlayHost.setEntries(CARD_SOURCE_ID, [card], CARD_HOST_OPTIONS);
  }

  /** Resolve a scene pick to one of this layer's selections, or null. */
  function pickedSelection(picked) {
    const pickId = picking.resolvePickId(picked);
    if (typeof pickId !== 'string') return null;
    if (pickId.startsWith(BULLETIN_PREFIX)) {
      const regionId = pickId.slice(BULLETIN_PREFIX.length);
      return _bulletins.has(regionId) ? { regionId } : null;
    }
    if (pickId.startsWith(ENTITY_PREFIX)) {
      const alertId = _entityToAlert.get(pickId);
      return alertId && _byId.has(alertId) ? { alertId } : null;
    }
    return null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    // Not registered as a pick owner: alert polygons are large, and claiming
    // them would make sibling cards inert anywhere over an alert area.
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const cardHit = overlayHost.hitTest?.(
        click.position?.x,
        click.position?.y,
        { sourceId: CARD_SOURCE_ID },
      );
      if (cardHit && cardHit.entryId === _selectedCardId) {
        const link = selectedLink();
        if (link && openExternal) openExternal(link);
        return;
      }
      const picked = _viewer.scene.pick(click.position);
      const selection = picked ? pickedSelection(picked) : null;
      if (selection) {
        _selected = selection;
        publishSelectedCard();
        return;
      }
      if (picked) {
        const pickId = picking.resolvePickId(picked);
        if (pickId && picking.isOwnedByOtherLayer(layer.id, pickId)) return;
      }
      if (_selected) {
        _selected = null;
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

  function clearSelection() {
    _selected = null;
    _selectedCardId = null;
    overlayHost.clearSource(CARD_SOURCE_ID);
    overlayHost.setVisible?.(CARD_SOURCE_ID, false);
  }

  /** Rebuild entities, labels and bulletin groups from the current alerts. */
  function render() {
    if (!_dataSource) return;
    _dataSource.entities.removeAll();
    _entityToAlert.clear();
    _bulletins.clear();
    const labels = [];
    let counter = 0;
    for (const alert of visible()) {
      const anchor = alertAnchor(alert);
      if (!anchor) {
        for (const regionId of alert.regions) {
          if (!_bulletins.has(regionId)) _bulletins.set(regionId, []);
          _bulletins.get(regionId).push(alert);
        }
        continue;
      }
      const color = colorFor(alert.severity);
      const position = Cesium.Cartesian3.fromDegrees(anchor.lon, anchor.lat);
      const geometry = alert.area;
      if (geometry.type === 'Point') {
        const id = `${ENTITY_PREFIX}${counter++}`;
        _entityToAlert.set(id, alert.id);
        _dataSource.entities.add(
          new Cesium.Entity({
            id,
            position,
            ellipse: {
              semiMajorAxis: MARKER_RADIUS_M,
              semiMinorAxis: MARKER_RADIUS_M,
              material: new Cesium.ColorMaterialProperty(color.withAlpha(0.35)),
              outline: true,
              outlineColor: color.withAlpha(0.9),
              outlineWidth: 2,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            },
          }),
        );
      } else {
        const polygons =
          geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
        for (const rings of polygons) {
          const [outer, ...holes] = rings;
          const outerPositions = ringPositions(outer);
          const id = `${ENTITY_PREFIX}${counter++}`;
          _entityToAlert.set(id, alert.id);
          _dataSource.entities.add(
            new Cesium.Entity({
              id,
              polygon: {
                hierarchy: new Cesium.PolygonHierarchy(
                  outerPositions,
                  holes.map((hole) => new Cesium.PolygonHierarchy(ringPositions(hole))),
                ),
                material: new Cesium.ColorMaterialProperty(color.withAlpha(0.18)),
              },
              polyline: {
                positions: outerPositions,
                clampToGround: true,
                width: 2,
                material: new Cesium.ColorMaterialProperty(color.withAlpha(0.85)),
              },
            }),
          );
        }
      }
      labels.push(
        createAlertOverlayEntry({
          id: alert.id,
          position,
          alert,
          accent: _colors[alertSeverity(alert.severity).id],
        }),
      );
    }
    for (const region of ALERT_REGIONS) {
      const bulletins = _bulletins.get(region.id);
      if (!bulletins?.length) continue;
      bulletins.sort(compareAlerts);
      const color = colorFor(bulletins[0].severity);
      const position = Cesium.Cartesian3.fromDegrees(region.anchor.lon, region.anchor.lat);
      _dataSource.entities.add(
        new Cesium.Entity({
          id: `${BULLETIN_PREFIX}${region.id}`,
          position,
          ellipse: {
            semiMajorAxis: BULLETIN_RADIUS_M,
            semiMinorAxis: BULLETIN_RADIUS_M,
            material: new Cesium.ColorMaterialProperty(color.withAlpha(0.12)),
            outline: true,
            outlineColor: color.withAlpha(0.7),
            outlineWidth: 2,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          },
        }),
      );
      labels.push({
        id: `bulletins:${region.id}`,
        position,
        variant: 'label',
        title: tn(
          bulletins.length,
          '{region} · {count} bulletin',
          '{region} · {count} bulletins',
          { region: region.name, count: formatNumber(bulletins.length) },
        ),
        accent: _colors[alertSeverity(bulletins[0].severity).id],
        priority: severityRank(bulletins[0].severity) * 1_000_000 + 999_998,
        collisionGroup: 'ambient-label',
        paintLane: 'ambient-label',
        interactive: false,
        edgeFade: 'keyhole',
        horizonCull: true,
        terrainOcclusion: false,
        gapPx: 14,
        verticalOnly: true,
        placement: 'above',
      });
    }
    if (_enabled)
      overlayHost.setEntries(
        ALERTS_OVERLAY_SOURCE_ID,
        selectAlertOverlayCohort(labels),
        {
          cohortLimit: ALERTS_OVERLAY_COHORT_LIMIT,
          collisionCapacity: ALERTS_OVERLAY_COLLISION_CAPACITY,
          moving: false,
        },
      );
    _count = visible().length;
    if (_selected) publishSelectedCard();
  }

  const layer = {
    id: ALERTS_LAYER_ID,
    name: 'Alerts',
    icon: '⚠',
    source: 'NWS · CAL FIRE · Caltrans · FAA · transit · agencies',
    updateInterval: 120_000,

    init(viewer) {
      if (_viewer) throw new Error('Alerts layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(ALERTS_LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _alerts = [];
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _stale = false;
      _partial = false;
      _enabled = false;
      overlayHost.setVisible(ALERTS_OVERLAY_SOURCE_ID, false);
      overlayHost.setVisible?.(CARD_SOURCE_ID, false);
    },

    enable() {
      _enabled = true;
      _colors = resolveSeverityColors(resolveToken);
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(ALERTS_OVERLAY_SOURCE_ID, true);
      overlayHost.setVisible?.(CARD_SOURCE_ID, true);
      installClickHandler();
      notify();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      removeClickHandler();
      clearSelection();
      overlayHost.clearSource(ALERTS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(ALERTS_OVERLAY_SOURCE_ID, false);
      notify();
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const snapshot = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        const now = Date.now();
        _alerts = snapshot.alerts
          .filter((alert) => alertIsCurrent(alert, now))
          .sort(compareAlerts);
        _byId.clear();
        for (const alert of _alerts) _byId.set(alert.id, alert);
        _sources = snapshot.sources;
        const asked = _sources.filter((entry) => entry.status !== 'key-required');
        _stale =
          asked.length > 0 && asked.every((entry) => entry.stale || entry.status === 'unavailable');
        _partial = asked.some((entry) => entry.status === 'unavailable' || entry.partial);
        render();
        _lastUpdate = now;
        _lastError = null;
        notify();
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request) return false;
        _lastError = error?.message || msg('Alerts source unavailable');
        console.warn('[Data:Alerts] Refresh failed:', _lastError);
        notify();
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    /** Which kinds are shown; the row's chips toggle them. */
    getParams() {
      return { kinds: ALERT_KIND_IDS.filter((kind) => _kinds.has(kind)) };
    },

    setParams(params) {
      const kinds = Array.isArray(params?.kinds)
        ? params.kinds.filter((kind) => ALERT_KIND_IDS.includes(kind))
        : null;
      if (!kinds) return false;
      _kinds = new Set(kinds);
      if (_dataSource) render();
      notify();
      return true;
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      removeClickHandler();
      clearSelection();
      overlayHost.clearSource(ALERTS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(ALERTS_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer?.dataSources?.remove(_dataSource, true);
        _dataSource = null;
      }
      _viewer = null;
      _enabled = false;
      _alerts = [];
      _byId.clear();
      _entityToAlert.clear();
      _bulletins.clear();
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _stale = false;
      _partial = false;
      rowControlsListener = null;
    },

    /** Kind chips, a severity legend with counts, and a feed health line. */
    getRowControls() {
      const shown = visible();
      const counts = countBySeverity(shown);
      const asked = _sources.filter((entry) => entry.status !== 'key-required');
      const live = asked.filter((entry) => entry.status === 'ok').length;
      return {
        chips: ALERT_KINDS.map((kind) => {
          const active = _kinds.has(kind.id);
          const next = active
            ? ALERT_KIND_IDS.filter((id) => _kinds.has(id) && id !== kind.id)
            : [...ALERT_KIND_IDS.filter((id) => _kinds.has(id)), kind.id];
          return {
            id: kind.id,
            label: t(kind.label),
            active,
            params: { kinds: next },
          };
        }),
        legend: ALERT_SEVERITIES.map((band, index) => ({
          label: t(band.label),
          color: _colors[band.id],
          count: counts[band.id],
          ...(index === 0
            ? {
                blurb: t(
                  "Colour shows severity. Bulletins without a map shape gather at each region's centre.",
                ),
              }
            : {}),
        })),
        info: asked.length
          ? t('{live} of {total} feeds live', { live, total: asked.length })
          : '',
        infoTitle: _sources
          .map(
            (entry) =>
              `${entry.label}: ${t(SOURCE_STATUS_LABELS[entry.status] || SOURCE_STATUS_LABELS.unavailable)}`,
          )
          .join('\n'),
      };
    },

    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    /** Snapshot alerts as JSON-safe records for the analyst query engine. */
    getAnalystRecords(maxCount = 2000) {
      if (!_enabled || !_alerts.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      return visible()
        .slice(0, limit)
        .map((alert, index) => mapAlertAnalystRecord(alert, index));
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _lastUpdate !== null && _stale,
        partial: _lastUpdate !== null && !_stale && _partial,
        sources: _sources.map(({ id, status, count, fetchedAt }) => ({
          id,
          status,
          count,
          fetchedAt,
        })),
      };
    },
  };
  return layer;
}
