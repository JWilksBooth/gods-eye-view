import { msg } from '../../../i18n/marker.js';
import { sortIncidentsNewestFirst } from '../../incidents/records.js';

/**
 * Cohort rank per incident type when the layer has more rows than the cap:
 * fires and hazards first, then calls with people involved, then road
 * events. Within a type the newest incident wins (see getEvents).
 */
export const INCIDENT_EVENT_PRIORITY = Object.freeze({
  fire: 40,
  hazard: 30,
  medical: 20,
  police: 20,
  closure: 10,
  traffic: 10,
  other: 0,
});

/** The hover title: the agency's own wording, then where, then who. */
function incidentTitle(row) {
  return row.typeDetail || row.location || row.description || row.agency;
}

/**
 * Live incidents (LIVE OPS regions) as event icons. The layer's drawn rows
 * are read through `getRows()`, newest first, so a capped cohort keeps the
 * freshest incidents of each type. The LIVE OPS region and type filters are
 * the layer's own (`setParams`), so the icons follow the console.
 *
 * The drawer detail reuses the incident card: the application wiring passes
 * `describe(row)`, which returns the card's lines (src/app/layers/events.js
 * builds them with `buildIncidentCard`), so the adapter itself stays free of
 * Cesium and the i18n catalogs.
 *
 * @param {object} options
 * @param {object} options.layer The incidents layer (src/layers/incidents).
 * @param {string} [options.layerId] Data-manager id the adapter follows.
 * @param {(row: object) => string[]} [options.describe] Drawer lines for a row.
 * @param {(url: string) => void} [options.openExternal] Opens the agency page.
 */
export function createIncidentsEventAdapter({
  layer,
  layerId = 'incidents',
  describe = null,
  openExternal = null,
}) {
  function rows() {
    const drawn = layer?.getRows?.();
    return Array.isArray(drawn) ? drawn : [];
  }

  function rowFor(event) {
    const id = event?.data?.incidentId ?? event?.id;
    return rows().find((row) => row.id === id) || event?.data?.row || null;
  }

  return {
    id: 'incidents',
    kind: 'incident',
    layerId,
    getEvents({ limit }) {
      const cap = Number.isFinite(limit)
        ? Math.max(0, Math.floor(limit))
        : Infinity;
      return sortIncidentsNewestFirst(rows())
        .slice(0, cap)
        .map((row) => ({
          id: row.id,
          lat: row.lat,
          lon: row.lon,
          title: incidentTitle(row),
          description: [row.location, row.area].filter(Boolean).join(' · '),
          source: row.sourceLabel || row.agency || null,
          time: row.time,
          priority: INCIDENT_EVENT_PRIORITY[row.type] ?? 0,
          data: {
            incidentId: row.id,
            type: row.type,
            agency: row.agency,
            region: row.region,
            url: row.url || null,
            row,
          },
        }));
    },
    feed(event) {
      const row = rowFor(event);
      const lines =
        row && typeof describe === 'function'
          ? describe(row).filter(Boolean)
          : [
              { label: msg('Type'), value: event.data?.type || '--' },
              { label: msg('Agency'), value: event.data?.agency || '--' },
            ];
      const url = row?.url || event.data?.url || null;
      const actions =
        url && typeof openExternal === 'function'
          ? [{ label: msg('Open at source'), run: () => openExternal(url) }]
          : [];
      return { type: 'detail', nearestCameras: true, lines, actions };
    },
  };
}
