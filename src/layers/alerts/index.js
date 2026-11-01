import * as Cesium from 'cesium';
import { formatNumber, msg, t, tn } from '../../i18n/index.js';
import {
  ALERTS_LAYER_ID,
  ALERTS_OVERLAY_SOURCE_ID,
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
import { ALERT_REGIONS, alertRegion } from './regions.js';
import {
  ALERTS_OVERLAY_COHORT_LIMIT,
  ALERTS_OVERLAY_COLLISION_CAPACITY,
  buildAlertCard,
  buildBulletinCard,
  createAlertOverlayEntry,
  selectAlertOverlayCohort,
} from './cards.js';
export * from './model.js';
export * from './cards.js';
export * from './regions.js';
export { createAlertsSource } from './source.js';

/** Screen size of a point alert's marker; constant at every zoom. */
const MARKER_PIXELS = 10;
/** A region's bulletin marker is a little larger: it stands for a list. */
const BULLETIN_PIXELS = 14;
/** Area fills stay light so the imagery under a large zone still reads. */
const AREA_FILL_ALPHA = 0.12;
const CARD_SOURCE_ID = `${ALERTS_OVERLAY_SOURCE_ID}-selected`;
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
/** Point markers and bulletin markers are claimed for picking; areas are not. */
const POINT_PREFIX = 'alert-point:';
const AREA_PREFIX = 'alert-area:';
const BULLETIN_PREFIX = 'alert-bulletins:';
/** The stylesheet token the marker outline reads (src/ui/styles/alerts.css). */
export const ALERT_OUTLINE_TOKEN = '--alert-marker-outline';
/** The token a band falls back to when its own is missing. */
const FALLBACK_TOKEN = '--accent';

const readToken = (resolveToken, name) => {
  try {
    const value = resolveToken?.(name);
    return typeof value === 'string' ? value.trim() : '';
  } catch {
    return '';
  }
};

const parseColor = (css) => {
  if (!css) return null;
  try {
    return Cesium.Color.fromCssColorString(css) || null;
  } catch {
    return null;
  }
};

/**
 * The colours the theme paints the layer with, read from the stylesheet's
 * tokens through `resolveToken` (src/ui/styles/alerts.css): one CSS colour
 * string per severity band plus the marker outline. A band whose token is
 * missing falls back to the accent token; with no stylesheet at all (a
 * headless host) a band resolves to null and is drawn in Cesium's neutral
 * white, so no colour is ever chosen here.
 */
export function resolveSeverityColors(resolveToken) {
  const fallback = readToken(resolveToken, FALLBACK_TOKEN);
  const colors = {};
  for (const band of ALERT_SEVERITIES) {
    const own = readToken(resolveToken, band.token);
    colors[band.id] = parseColor(own)
      ? own
      : parseColor(fallback)
        ? fallback
        : null;
  }
  const outline = readToken(resolveToken, ALERT_OUTLINE_TOKEN);
  colors.outline = parseColor(outline) ? outline : null;
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
  now = () => Date.now(),
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
  let _region = null;
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
  const cssFor = (severity) => _colors[alertSeverity(severity).id] || null;
  const colorFor = (severity) =>
    parseColor(cssFor(severity)) || Cesium.Color.WHITE;
  const outlineColor = () =>
    parseColor(_colors.outline)?.withAlpha(0.85) ||
    Cesium.Color.WHITE.withAlpha(0.5);
  const ownsPickId = (id) =>
    _enabled &&
    typeof id === 'string' &&
    (id.startsWith(POINT_PREFIX) || id.startsWith(BULLETIN_PREFIX)) &&
    (_entityToAlert.has(id) ||
      _bulletins.has(id.slice(BULLETIN_PREFIX.length)));

  function visible() {
    return _alerts.filter(
      (alert) =>
        _kinds.has(alert.kind) &&
        (!_region || alert.regions?.includes(_region)),
    );
  }

  function bulletinLink(regionId) {
    const bulletins = _bulletins.get(regionId) || [];
    return (
      bulletins
        .slice()
        .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
        .find((alert) => alert.url)?.url || null
    );
  }

  function selectedLink() {
    if (!_selected) return null;
    if (_selected.alertId) return _byId.get(_selected.alertId)?.url || null;
    return bulletinLink(_selected.regionId);
  }

  function publishSelectedCard() {
    if (!canSelect()) return;
    const at = now();
    const link = openExternal ? selectedLink() : null;
    let card = null;
    if (_selected?.alertId) {
      const alert = _byId.get(_selected.alertId);
      const anchor =
        alert && _kinds.has(alert.kind) ? alertAnchor(alert) : null;
      if (anchor)
        card = {
          ...buildAlertCard(alert, at, {
            accent: cssFor(alert.severity),
            link,
          }),
          position: Cesium.Cartesian3.fromDegrees(anchor.lon, anchor.lat),
        };
    } else if (_selected?.regionId) {
      const region = alertRegion(_selected.regionId);
      const bulletins = _bulletins.get(_selected.regionId) || [];
      if (region && bulletins.length)
        card = {
          ...buildBulletinCard(region, bulletins, at, {
            accent: cssFor(bulletins[0].severity),
            link,
          }),
          position: Cesium.Cartesian3.fromDegrees(
            region.anchor.lon,
            region.anchor.lat,
          ),
        };
    }
    if (!card) {
      _selected = null;
      _selectedCardId = null;
      overlayHost.setEntries(CARD_SOURCE_ID, [], CARD_HOST_OPTIONS);
      return;
    }
    if (!openExternal) card.interactive = false;
    if (link) {
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
    if (pickId.startsWith(POINT_PREFIX) || pickId.startsWith(AREA_PREFIX)) {
      const alertId = _entityToAlert.get(pickId);
      return alertId && _byId.has(alertId) ? { alertId } : null;
    }
    return null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    // Area polygons are deliberately not claimed: they are large, and sibling
    // layers yield to owned picks, which would make their cards inert
    // anywhere over an alert area. Point and bulletin markers are claimed.
    picking.registerPickOwner?.(ALERTS_LAYER_ID, ownsPickId);
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
    picking?.unregisterPickOwner?.(ALERTS_LAYER_ID);
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

  function pointEntity(id, position, color, pixelSize) {
    return new Cesium.Entity({
      id,
      position,
      point: {
        pixelSize,
        color: color.withAlpha(0.95),
        outlineColor: outlineColor(),
        outlineWidth: 2,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }

  /** Rebuild entities, labels and bulletin groups from the current alerts. */
  function render() {
    if (!_dataSource) return;
    _dataSource.entities.removeAll();
    _entityToAlert.clear();
    _bulletins.clear();
    const labels = [];
    let counter = 0;
    const shown = visible();
    for (const alert of shown) {
      const anchor = alertAnchor(alert);
      if (!anchor) {
        for (const regionId of alert.regions) {
          if (_region && regionId !== _region) continue;
          if (!_bulletins.has(regionId)) _bulletins.set(regionId, []);
          _bulletins.get(regionId).push(alert);
        }
        continue;
      }
      const color = colorFor(alert.severity);
      const position = Cesium.Cartesian3.fromDegrees(anchor.lon, anchor.lat);
      const geometry = alert.area;
      if (geometry.type === 'Point') {
        const id = `${POINT_PREFIX}${counter++}`;
        _entityToAlert.set(id, alert.id);
        _dataSource.entities.add(
          pointEntity(id, position, color, MARKER_PIXELS),
        );
      } else {
        const polygons =
          geometry.type === 'Polygon'
            ? [geometry.coordinates]
            : geometry.coordinates;
        for (const rings of polygons) {
          const [outer, ...holes] = rings;
          const outerPositions = ringPositions(outer);
          const id = `${AREA_PREFIX}${counter++}`;
          _entityToAlert.set(id, alert.id);
          _dataSource.entities.add(
            new Cesium.Entity({
              id,
              polygon: {
                hierarchy: new Cesium.PolygonHierarchy(
                  outerPositions,
                  holes.map(
                    (hole) => new Cesium.PolygonHierarchy(ringPositions(hole)),
                  ),
                ),
                material: new Cesium.ColorMaterialProperty(
                  color.withAlpha(AREA_FILL_ALPHA),
                ),
              },
              polyline: {
                positions: outerPositions,
                clampToGround: true,
                width: 2,
                material: new Cesium.ColorMaterialProperty(
                  color.withAlpha(0.85),
                ),
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
          accent: cssFor(alert.severity),
        }),
      );
    }
    for (const region of ALERT_REGIONS) {
      const bulletins = _bulletins.get(region.id);
      if (!bulletins?.length) continue;
      bulletins.sort(compareAlerts);
      const worst = bulletins[0].severity;
      const position = Cesium.Cartesian3.fromDegrees(
        region.anchor.lon,
        region.anchor.lat,
      );
      _dataSource.entities.add(
        pointEntity(
          `${BULLETIN_PREFIX}${region.id}`,
          position,
          colorFor(worst),
          BULLETIN_PIXELS,
        ),
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
        accent: cssFor(worst),
        priority: severityRank(worst) * 1_000_000 + 999_998,
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
    _count = shown.length;
    if (_selected) publishSelectedCard();
  }

  const layer = {
    id: ALERTS_LAYER_ID,
    name: 'Alerts',
    icon: '⚠',
    source: 'NWS · CAL FIRE · Caltrans · FAA · AirNow · transit · agencies',
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
        const snapshot = await source.getSnapshot({
          signal: request.signal,
          region: _region,
        });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        const at = now();
        _colors = resolveSeverityColors(resolveToken);
        _alerts = snapshot.alerts
          .filter((alert) => alertIsCurrent(alert, at))
          .sort(compareAlerts);
        _byId.clear();
        for (const alert of _alerts) _byId.set(alert.id, alert);
        _sources = Array.isArray(snapshot.sources) ? snapshot.sources : [];
        const asked = _sources.filter(
          (entry) => entry.status !== 'key-required',
        );
        _stale =
          asked.length > 0 &&
          asked.every((entry) => entry.stale || entry.status === 'unavailable');
        _partial = asked.some(
          (entry) => entry.status === 'unavailable' || entry.partial,
        );
        render();
        _lastUpdate = at;
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

    /** Which kinds are shown and which region (null for all). */
    getParams() {
      return {
        kinds: ALERT_KIND_IDS.filter((kind) => _kinds.has(kind)),
        region: _region,
      };
    },

    /**
     * Change the shown kinds (the row's chips) or limit the layer to one
     * LIVE OPS region; an unknown region clears the limit.
     */
    setParams(params = {}) {
      let changed = false;
      if (Array.isArray(params?.kinds)) {
        _kinds = new Set(
          params.kinds.filter((kind) => ALERT_KIND_IDS.includes(kind)),
        );
        changed = true;
      }
      if (params?.region !== undefined) {
        _region = alertRegion(params.region)?.id ?? null;
        changed = true;
      }
      if (!changed) return false;
      if (_dataSource) render();
      notify();
      return true;
    },

    /**
     * The alert or region bulletin a pick id or headline names, for voice
     * deixis ("this alert"): `{ id, name, latitude, longitude }`, or null.
     */
    findByQuery(query) {
      const text = String(query ?? '').trim();
      if (!text) return null;
      if (text.startsWith(BULLETIN_PREFIX)) {
        const region = alertRegion(text.slice(BULLETIN_PREFIX.length));
        const bulletins = region ? _bulletins.get(region.id) : null;
        if (!bulletins?.length) return null;
        return {
          id: text,
          name: `${region.name}: ${bulletins[0].headline}`,
          latitude: region.anchor.lat,
          longitude: region.anchor.lon,
        };
      }
      const lower = text.toLowerCase();
      const alert =
        _byId.get(_entityToAlert.get(text)) ||
        _byId.get(text) ||
        visible().find((entry) =>
          String(entry.headline).toLowerCase().includes(lower),
        );
      if (!alert) return null;
      const anchor = alertAnchor(alert);
      return {
        id: alert.id,
        name: alert.headline,
        latitude: anchor?.lat ?? null,
        longitude: anchor?.lon ?? null,
      };
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
      _sources = [];
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
      // With a region chosen, only the feeds that speak for it are counted.
      const covering = _sources.filter(
        (entry) =>
          !_region ||
          !Array.isArray(entry.regions) ||
          entry.regions.includes(_region),
      );
      const asked = covering.filter((entry) => entry.status !== 'key-required');
      const live = asked.filter((entry) => entry.status === 'ok').length;
      const statusWord = (status) => {
        if (status === 'ok') return t('live', { context: 'feed status' });
        if (status === 'key-required') return t('key required');
        if (status === 'unavailable') return t('unavailable');
        return t('stale');
      };
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
        // The panel paints swatches in the DOM, where the token itself works
        // and follows the theme without a re-render.
        legend: ALERT_SEVERITIES.map((band, index) => ({
          label: t(band.label),
          color: `var(${band.token})`,
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
        infoTitle: covering
          .map((entry) => `${entry.label}: ${statusWord(entry.status)}`)
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
        sources: _sources.map(({ id, status, count, fetchedAt, error }) => ({
          id,
          status,
          count,
          fetchedAt,
          error: error ?? null,
        })),
      };
    },
  };
  return layer;
}
