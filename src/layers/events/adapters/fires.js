import { msg } from '../../../i18n/marker.js';

/**
 * NASA FIRMS detections from the fires layer, strongest first (the layer's
 * analyst records walk its FRP-sorted index, so the cap keeps the fires
 * that matter).
 * @param {{layer: object, layerId?: string}} options
 */
export function createFiresEventAdapter({ layer, layerId = 'local-firms' }) {
  return {
    id: 'fires',
    kind: 'fire',
    layerId,
    getEvents({ limit }) {
      const records = layer?.getAnalystRecords?.(limit) || [];
      return records.map((fire) => ({
        id: fire.id,
        lat: fire.lat,
        lon: fire.lon,
        // i18n-ignore: numeric readout with a unit symbol
        title: `FRP ${Number.isFinite(fire.frp) ? Math.round(fire.frp) : '--'} MW`,
        description: [
          fire.sensor || fire.satellite,
          Number.isFinite(fire.confidence)
            ? `${Math.round(fire.confidence * 100)}%`
            : null,
        ]
          .filter(Boolean)
          .join(' · '),
        source: 'NASA FIRMS',
        time: fire.acqTime,
        priority: Number.isFinite(fire.frp) ? fire.frp : 0,
        data: {
          frp: fire.frp,
          confidence: fire.confidence,
          sensor: fire.sensor,
        },
      }));
    },
    feed(event) {
      const { frp, confidence, sensor } = event.data || {};
      return {
        type: 'detail',
        nearestCameras: true,
        lines: [
          {
            label: msg('Radiative power'),
            value: Number.isFinite(frp) ? `${Math.round(frp)} MW` : '--',
          },
          {
            label: msg('Confidence'),
            value: Number.isFinite(confidence)
              ? `${Math.round(confidence * 100)}%`
              : '--',
          },
          { label: msg('Sensor'), value: sensor || '--' },
        ],
      };
    },
  };
}
