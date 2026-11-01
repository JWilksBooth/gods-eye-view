import { greatCircleKm } from '../../../geoDistance.js';
import { msg } from '../../../i18n/marker.js';

/**
 * Ships from the live AIS layer, nearest the camera's ground point first.
 * @param {{layer: object, layerId?: string}} options
 */
export function createVesselsEventAdapter({ layer, layerId = 'ais-live-vessels' }) {
  return {
    id: 'vessels',
    kind: 'vessel',
    layerId,
    getEvents({ limit, center }) {
      const records = (layer?.getAnalystRecords?.(4000) || []).filter(
        (record) =>
          Number.isFinite(record.lat) && Number.isFinite(record.lon) && record.mmsi,
      );
      const ranked = center
        ? records
            .map((record) => ({
              record,
              km: greatCircleKm(center, { lat: record.lat, lon: record.lon }),
            }))
            .sort((a, b) => a.km - b.km)
            .slice(0, limit)
            .map((entry) => entry.record)
        : records.slice(0, limit);
      return ranked.map((vessel) => ({
        id: vessel.mmsi,
        lat: vessel.lat,
        lon: vessel.lon,
        title: vessel.name || vessel.mmsi,
        description: [
          vessel.shipType,
          Number.isFinite(vessel.speedKts) ? `${Math.round(vessel.speedKts)} kt` : null,
          Number.isFinite(vessel.courseDeg) ? `${Math.round(vessel.courseDeg)}°` : null,
          vessel.destination ? `→ ${vessel.destination}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
        source: 'AISStream.io',
        data: {
          mmsi: vessel.mmsi,
          shipType: vessel.shipType,
          speedKts: vessel.speedKts,
          courseDeg: vessel.courseDeg,
          destination: vessel.destination,
        },
      }));
    },
    feed(event) {
      const data = event.data || {};
      return {
        type: 'detail',
        lines: [
          { label: msg('MMSI'), value: data.mmsi || '--' },
          { label: msg('Type'), value: data.shipType || '--' },
          { label: msg('Speed'), value: Number.isFinite(data.speedKts) ? `${Math.round(data.speedKts)} kt` : '--' },
          { label: msg('Course'), value: Number.isFinite(data.courseDeg) ? `${Math.round(data.courseDeg)}°` : '--' },
          { label: msg('Destination'), value: data.destination || '--' },
        ],
        actions: data.mmsi && typeof layer?.selectById === 'function'
          ? [{ label: msg('Select on map'), run: () => layer.selectById(data.mmsi) }]
          : [],
      };
    },
  };
}
