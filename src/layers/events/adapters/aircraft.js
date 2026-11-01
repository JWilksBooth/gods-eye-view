import { greatCircleKm } from '../../../geoDistance.js';
import { msg } from '../../../i18n/marker.js';

const FT_PER_M = 3.28084;
const KT_PER_MPS = 1.943844;

function nearestFirst(records, center, limit) {
  if (!center) return records.slice(0, limit);
  return records
    .map((record) => ({
      record,
      km: greatCircleKm(center, { lat: record.lat, lon: record.lon }),
    }))
    .sort((a, b) => a.km - b.km)
    .slice(0, limit)
    .map((entry) => entry.record);
}

/**
 * Aircraft from a flights layer (civil or military), nearest the camera's
 * ground point first. An emergency broadcast outranks distance.
 * @param {{layer: object, layerId?: string, id?: string}} options
 */
export function createAircraftEventAdapter({
  layer,
  layerId = 'flights',
  id = 'aircraft',
}) {
  return {
    id,
    kind: 'aircraft',
    layerId,
    getEvents({ limit, center }) {
      const records = (layer?.getAnalystRecords?.(4000) || []).filter(
        (record) => Number.isFinite(record.lat) && Number.isFinite(record.lon),
      );
      return nearestFirst(records, center, limit).map((aircraft) => {
        const altitudeFt = Number.isFinite(aircraft.altitudeM)
          ? Math.round((aircraft.altitudeM * FT_PER_M) / 100) * 100
          : null;
        const knots = Number.isFinite(aircraft.speedMps)
          ? Math.round(aircraft.speedMps * KT_PER_MPS)
          : null;
        return {
          id: aircraft.icao24 || aircraft.id,
          lat: aircraft.lat,
          lon: aircraft.lon,
          altitudeM: aircraft.onGround ? null : aircraft.altitudeM,
          title: aircraft.callsign || aircraft.id || aircraft.icao24,
          description: [
            altitudeFt !== null ? `${altitudeFt} ft` : null,
            knots !== null ? `${knots} kt` : null,
            Number.isFinite(aircraft.heading)
              ? `${Math.round(aircraft.heading)}°`
              : null,
            aircraft.routeOrigin && aircraft.routeDestination
              ? `${aircraft.routeOrigin}→${aircraft.routeDestination}`
              : null,
          ]
            .filter(Boolean)
            .join(' · '),
          source: aircraft.military ? 'adsb.lol' : 'OpenSky Network',
          time: aircraft.lastContactAtMs,
          priority: aircraft.emergency ? 100 : aircraft.military ? 1 : 0,
          data: {
            icao24: aircraft.icao24,
            callsign: aircraft.callsign,
            operator: aircraft.operator,
            aircraftClass: aircraft.aircraftClass,
            squawk: aircraft.squawk,
            emergency: aircraft.emergency,
            emergencyBroadcast: aircraft.emergencyBroadcast,
            altitudeFt,
            knots,
            heading: aircraft.heading,
            originCountry: aircraft.originCountry,
          },
        };
      });
    },
    feed(event) {
      const data = event.data || {};
      return {
        type: 'detail',
        lines: [
          { label: msg('ICAO'), value: data.icao24 || '--' },
          { label: msg('Operator'), value: data.operator || '--' },
          { label: msg('Class'), value: data.aircraftClass || '--' },
          {
            label: msg('Altitude'),
            value:
              data.altitudeFt !== null && data.altitudeFt !== undefined
                ? `${data.altitudeFt} ft`
                : '--',
          },
          {
            label: msg('Speed'),
            value:
              data.knots !== null && data.knots !== undefined
                ? `${data.knots} kt`
                : '--',
          },
          {
            label: msg('Heading'),
            value: Number.isFinite(data.heading)
              ? `${Math.round(data.heading)}°`
              : '--',
          },
          { label: msg('Squawk'), value: data.squawk || '--' },
          ...(data.emergencyBroadcast
            ? [{ label: msg('Emergency'), value: data.emergencyBroadcast }]
            : []),
        ],
        actions:
          data.icao24 && typeof layer?.trackById === 'function'
            ? [
                {
                  label: msg('Follow'),
                  run: () => layer.trackById(data.icao24, { origin: 'user' }),
                },
              ]
            : [],
      };
    },
  };
}
