import { msg } from '../../../i18n/marker.js';
import {
  alertAnchor,
  alertSeverity,
  compareAlerts,
  msOrNull,
  severityRank,
} from '../../alerts/model.js';
import { alertRegion } from '../../alerts/regions.js';

/** Cohort rank per severity band: extreme 40 … unknown 0. */
export function alertEventPriority(severity) {
  return severityRank(severity) * 10;
}

/** The host a source link opens, without `www.`, or null. */
function sourceHost(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/**
 * Where an alert's icon goes: its own anchor (the point, or the centre of
 * its largest polygon), else the centre of the first LIVE OPS region it
 * names, where the alerts layer gathers its shapeless bulletins too.
 * @returns {{lat: number, lon: number, placement: 'area'|'region'}|null}
 */
export function alertEventPosition(alert) {
  const anchor = alertAnchor(alert);
  if (anchor) return { ...anchor, placement: 'area' };
  for (const regionId of alert?.regions || []) {
    const region = alertRegion(regionId);
    if (region?.anchor) return { ...region.anchor, placement: 'region' };
  }
  return null;
}

/**
 * Official alerts (NWS, CAL FIRE, Caltrans, FAA, agency feeds, AirNow,
 * transit) as event icons. The layer's current alerts are read through
 * `getAlerts()` (the drawn set, after its kind and region filters), worst
 * severity first and newest within a severity, so a capped cohort keeps the
 * warnings that matter. The hover line is the headline with the agency and
 * severity; the drawer reuses the alerts card through `describe(alert)`,
 * supplied by the application wiring (src/app/layers/events.js builds it
 * with `buildAlertCard`), so this module stays free of Cesium and the i18n
 * catalogs.
 *
 * @param {object} options
 * @param {object} options.layer The alerts layer (src/layers/alerts).
 * @param {string} [options.layerId] Data-manager id the adapter follows.
 * @param {(alert: object) => string[]} [options.describe] Drawer lines.
 * @param {(severity: string) => string} [options.severityLabel] The band's
 *   label in the UI language; defaults to the English label.
 * @param {(url: string) => void} [options.openExternal] Opens the source page.
 */
export function createAlertsEventAdapter({
  layer,
  layerId = 'alerts',
  describe = null,
  severityLabel = (severity) => alertSeverity(severity).label,
  openExternal = null,
}) {
  function alerts() {
    const current = layer?.getAlerts?.();
    return Array.isArray(current) ? current : [];
  }

  function alertFor(event) {
    const id = event?.data?.alertId ?? event?.id;
    return (
      alerts().find((alert) => alert.id === id) || event?.data?.alert || null
    );
  }

  return {
    id: 'alerts',
    kind: 'alert',
    layerId,
    getEvents({ limit }) {
      const cap = Number.isFinite(limit)
        ? Math.max(0, Math.floor(limit))
        : Infinity;
      const events = [];
      for (const alert of alerts().slice().sort(compareAlerts)) {
        if (events.length >= cap) break;
        const position = alertEventPosition(alert);
        if (!position) continue;
        events.push({
          id: alert.id,
          lat: position.lat,
          lon: position.lon,
          title: alert.headline,
          description: [alert.agency, severityLabel(alert.severity)]
            .filter(Boolean)
            .join(' · '),
          source: sourceHost(alert.url) || alert.source || null,
          time: msOrNull(alert.issued) ?? msOrNull(alert.starts) ?? null,
          priority: alertEventPriority(alert.severity),
          data: {
            alertId: alert.id,
            kind: alert.kind,
            severity: alertSeverity(alert.severity).id,
            agency: alert.agency,
            regions: alert.regions || [],
            placement: position.placement,
            url: alert.url || null,
            alert,
          },
        });
      }
      return events;
    },
    feed(event) {
      const alert = alertFor(event);
      const lines =
        alert && typeof describe === 'function'
          ? describe(alert).filter(Boolean)
          : [
              {
                label: msg('Severity'),
                value: severityLabel(event.data?.severity) || '--',
              },
              { label: msg('Agency'), value: event.data?.agency || '--' },
            ];
      const url = alert?.url || event.data?.url || null;
      const actions =
        url && typeof openExternal === 'function'
          ? [{ label: msg('Open at source'), run: () => openExternal(url) }]
          : [];
      return { type: 'detail', nearestCameras: true, lines, actions };
    },
  };
}
