import { msg } from '../../../i18n/marker.js';

const FEED_LABELS = Object.freeze({
  video: msg('live video'),
  image: msg('still frames'),
});

/**
 * Public cameras from the CCTV layer, read through its UI state (the same
 * per-camera records the camera picker lists). The full catalog is mapped
 * only when the layer's count or active camera changes; the nearest-first
 * cut happens on every read.
 * @param {{layer: object, layerId?: string}} options
 */
export function createCctvEventAdapter({ layer, layerId = 'cctv' }) {
  let cacheKey = null;
  let cached = [];

  function cameras() {
    const ui = layer?.getUIState?.();
    if (!ui?.enabled) return [];
    const key = `${ui.count}:${ui.lastUpdate}:${ui.activeCameraId}:${ui.loading?.loaded}`;
    if (key !== cacheKey) {
      cacheKey = key;
      cached = (ui.cameras || []).map((camera) => ({
        id: camera.id,
        lat: camera.lat,
        lon: camera.lon,
        title: camera.name || camera.id,
        description: [
          camera.city,
          FEED_LABELS[camera.isVideo ? 'video' : 'image'],
        ]
          .filter(Boolean)
          .join(' · '),
        source: camera.credit || camera.provider || null,
        priority: camera.active ? 10 : camera.isVideo ? 2 : 0,
        data: {
          cameraId: camera.id,
          isVideo: camera.isVideo === true,
          feedType: camera.feedType,
          camera: {
            id: camera.id,
            name: camera.name,
            city: camera.city,
            lat: camera.lat,
            lon: camera.lon,
            headingDeg: camera.headingDeg,
            fovDeg: camera.fovDeg,
            pitchDeg: camera.pitchDeg,
            provider: camera.provider,
            credit: camera.credit,
          },
        },
      }));
    }
    return cached;
  }

  return {
    id: 'cctv',
    kind: 'camera',
    layerId,
    getEvents({ limit }) {
      return cameras().slice(0, Number.isFinite(limit) ? limit * 4 : undefined);
    },
    feed(event) {
      return {
        type: 'camera',
        layerId,
        cameraId: event.data?.cameraId || event.id,
        isVideo: event.data?.isVideo === true,
        camera: event.data?.camera || null,
      };
    },
  };
}
