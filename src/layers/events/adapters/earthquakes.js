import { msg } from '../../../i18n/marker.js';

/**
 * USGS events from the earthquakes layer. Magnitude is the priority, so a
 * capped cohort keeps the strongest shocks.
 * @param {{layer: object, layerId?: string}} options
 */
export function createEarthquakesEventAdapter({
  layer,
  layerId = 'earthquakes',
}) {
  return {
    id: 'earthquakes',
    kind: 'quake',
    layerId,
    getEvents({ limit }) {
      const records = layer?.getAnalystRecords?.(limit) || [];
      return records.map((quake) => ({
        id: quake.id,
        lat: quake.lat,
        lon: quake.lon,
        // i18n-ignore: magnitude readout
        title: `M ${Number.isFinite(quake.magnitude) ? quake.magnitude.toFixed(1) : '--'}`,
        description: quake.place || null,
        source: 'USGS',
        time: quake.timeMs,
        priority: Number.isFinite(quake.magnitude) ? quake.magnitude : 0,
        data: {
          magnitude: quake.magnitude,
          depthKm: quake.depthKm,
          place: quake.place,
        },
      }));
    },
    feed(event) {
      const { magnitude, depthKm, place } = event.data || {};
      return {
        type: 'detail',
        nearestCameras: true,
        lines: [
          {
            label: msg('Magnitude'),
            value: Number.isFinite(magnitude) ? magnitude.toFixed(1) : '--',
          },
          {
            label: msg('Depth'),
            value: Number.isFinite(depthKm)
              ? `${Math.round(depthKm)} km`
              : '--',
          },
          { label: msg('Place'), value: place || '--' },
        ],
      };
    },
  };
}
