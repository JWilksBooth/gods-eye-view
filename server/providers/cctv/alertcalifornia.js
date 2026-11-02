/**
 * ALERTCalifornia (UC San Diego) fire cameras: the ridge-top pack for the
 * California LIVE OPS regions (Los Angeles, Sonoma County, the Bay Area).
 *
 * One keyless GeoJSON catalog lists every camera
 * (`public-camera-data/all_cameras-v3.json`, about 1,300 features), each
 * with its mast position and elevation, the Axis model, the current
 * pan/tilt/zoom and field of view, the sponsor and the time of its last
 * frame. The latest still of a camera is
 * `public-camera-data/<id>/latest-frame.jpg`, which answers a same-host 302
 * to the frame object; the frame proxy follows redirects on the original
 * origin only (media.js), which is exactly this hop.
 *
 * Terms (alertcalifornia.org/terms, /crediting-and-branding): the program's
 * data is CC BY-NC-ND 4.0 and "live camera feeds are available for public
 * use with credit", the credit being "ALERTCalifornia | UC San Diego". The
 * pack carries that credit on every camera, the frames are shown as served
 * (no cropping or compositing; ND), and the licence is non-commercial, which
 * DATA_SOURCES.md records. No stream URL is public, so every camera is a
 * still; frames are fetched at request time and never stored.
 */
import { CCTV_SOURCE_FETCH_TIMEOUT_MS } from './constants.js';
import {
  fallbackHeadingFromId,
  pinnedCameraUrl,
  prioritizeSources,
  toFiniteNumber,
} from './normalize.js';
import { readResponseJsonCapped } from '../common/http.js';
import { haversineKm } from '../common/geo.js';

export const ALERTCA_ORIGIN = 'https://cameras.alertcalifornia.org';
export const ALERTCA_DATA_ORIGIN = `${ALERTCA_ORIGIN}/public-camera-data/`;
export const ALERTCA_CATALOG_URL = `${ALERTCA_DATA_ORIGIN}all_cameras-v3.json`;
export const ALERTCA_CREDIT = 'ALERTCalifornia | UC San Diego';
export const DEFAULT_ALERTCA_MAX_SOURCES = 500;
/** The catalog is about 740 KB; a run-away answer stops well before this. */
export const ALERTCA_MAX_CATALOG_BYTES = 6 * 1024 * 1024;
/** A camera whose last frame is older than this is out of service. */
export const ALERTCA_STALE_FRAME_MS = 24 * 60 * 60 * 1000;
/** Prioritization anchors: the California LIVE OPS regions. */
export const ALERTCA_ANCHORS = [
  { lat: 34.0537, lon: -118.2428 }, // Los Angeles
  { lat: 37.7793, lon: -122.4193 }, // San Francisco
  { lat: 38.44, lon: -122.71 }, // Sonoma County
];
/** Ridge cameras look a long way; the client clamps a catalog range at 2.2 km. */
const RANGE_MIN_M = 300;
const RANGE_MAX_M = 2200;
const DEFAULT_RANGE_M = 1800;
const MAST_HEIGHT_M = 15;

/** Counties the catalog writes without spaces; the rest capitalize as one word. */
const COUNTY_NAMES = Object.freeze({
  contracosta: 'Contra Costa',
  delnorte: 'Del Norte',
  eldorado: 'El Dorado',
  losangeles: 'Los Angeles',
  sanbenito: 'San Benito',
  sanbernardino: 'San Bernardino',
  sandiego: 'San Diego',
  sanfrancisco: 'San Francisco',
  sanjoaquin: 'San Joaquin',
  sanluisobispo: 'San Luis Obispo',
  sanmateo: 'San Mateo',
  santabarbara: 'Santa Barbara',
  santaclara: 'Santa Clara',
  santacruz: 'Santa Cruz',
});

/** "sanmateo" → "San Mateo County"; blank for no county. */
export function alertCaliforniaCountyLabel(county) {
  const key = String(county || '')
    .trim()
    .toLowerCase();
  if (!key) return '';
  const name = COUNTY_NAMES[key] || key.charAt(0).toUpperCase() + key.slice(1);
  return `${name} County`;
}

/** Initial bearing from one point to another, degrees clockwise from north. */
function bearingDeg(fromLat, fromLon, toLat, toLon) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLon = toRad(toLon - fromLon);
  const lat1 = toRad(fromLat);
  const lat2 = toRad(toLat);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
}

/** The official still for a camera id, or null when the id is not plain. */
export function alertCaliforniaFrameUrl(rawId) {
  const id = String(rawId ?? '').trim();
  if (!/^[a-z0-9][a-z0-9_.-]{0,80}$/i.test(id)) return null;
  return pinnedCameraUrl(
    `${ALERTCA_DATA_ORIGIN}${id}/latest-frame.jpg`,
    ALERTCA_DATA_ORIGIN,
  );
}

/**
 * One GeoJSON feature → a camera source, or null when it has no plain id,
 * no finite position, or its last frame is older than ALERTCA_STALE_FRAME_MS.
 * @param {object} feature
 * @param {number} [nowMs]
 */
export function alertCaliforniaFeatureToSource(feature, nowMs = Date.now()) {
  const props = feature?.properties;
  const coords = feature?.geometry?.coordinates;
  if (!props || typeof props !== 'object' || !Array.isArray(coords))
    return null;
  const rawId = String(props.id ?? '').trim();
  const imageUrl = alertCaliforniaFrameUrl(rawId);
  if (!imageUrl) return null;
  const lon = toFiniteNumber(coords[0]);
  const lat = toFiniteNumber(coords[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  const lastFrameMs = toFiniteNumber(props.last_frame_ts) * 1000;
  if (
    !Number.isFinite(lastFrameMs) ||
    nowMs - lastFrameMs > ALERTCA_STALE_FRAME_MS
  )
    return null;

  const cameraId = `alertca-${rawId.toLowerCase()}`;
  let heading = toFiniteNumber(props.az_current);
  let headingConfidence = 'high';
  if (!Number.isFinite(heading)) {
    // The catalog also draws the view cone; its centre gives a bearing when
    // the PTZ readout is missing.
    const centre = Array.isArray(props.fov_center) ? props.fov_center : null;
    const cLon = toFiniteNumber(centre?.[0]);
    const cLat = toFiniteNumber(centre?.[1]);
    if (Number.isFinite(cLat) && Number.isFinite(cLon)) {
      heading = bearingDeg(lat, lon, cLat, cLon);
      headingConfidence = 'medium';
    } else {
      heading = fallbackHeadingFromId(cameraId);
      headingConfidence = 'low';
    }
  }
  heading = ((heading % 360) + 360) % 360;
  const fovRaw = toFiniteNumber(props.fov);
  const fovDeg = Number.isFinite(fovRaw)
    ? Math.max(20, Math.min(125, fovRaw))
    : 60;
  const tilt = toFiniteNumber(props.tilt_current);
  // Axis tilt: negative looks down. A ridge camera often sits a few degrees
  // either side of the horizon; the pose model wants a downward pitch.
  const pitchDeg = Number.isFinite(tilt)
    ? Math.max(-40, Math.min(-2, tilt))
    : -4;
  const centre = Array.isArray(props.fov_center) ? props.fov_center : null;
  const cLon = toFiniteNumber(centre?.[0]);
  const cLat = toFiniteNumber(centre?.[1]);
  const viewKm =
    Number.isFinite(cLat) && Number.isFinite(cLon)
      ? haversineKm(lat, lon, cLat, cLon)
      : NaN;
  const rangeM = Number.isFinite(viewKm)
    ? Math.max(RANGE_MIN_M, Math.min(RANGE_MAX_M, Math.round(viewKm * 1000)))
    : DEFAULT_RANGE_M;
  const elevation = toFiniteNumber(coords[2]);
  const county = alertCaliforniaCountyLabel(props.county);
  const name = String(props.name || '').trim() || rawId;
  const model = String(props.ProdNbr || '').trim();
  return {
    id: cameraId,
    name: name.slice(0, 160),
    city: county || 'California',
    cityId: 'alertcalifornia',
    provider: 'ALERTCalifornia',
    credit: ALERTCA_CREDIT,
    lat,
    lon,
    headingDeg: heading,
    headingConfidence,
    pitchDeg,
    fovDeg,
    rangeM,
    mountHeightM: MAST_HEIGHT_M,
    ...(Number.isFinite(elevation) ? { groundElevationM: elevation } : {}),
    ...(model ? { model, manufacturer: 'Axis' } : {}),
    feedType: 'image',
    url: imageUrl,
    snapshotUrl: imageUrl,
    sourceKind: 'alertcalifornia',
    license:
      'ALERTCalifornia camera frame, CC BY-NC-ND 4.0: public use with the credit "ALERTCalifornia | UC San Diego", non-commercial, shown as served',
  };
}

/**
 * Every usable camera in a catalog payload (a GeoJSON FeatureCollection or
 * a bare feature array), in catalog order, duplicates by id dropped.
 * @param {object|Array} payload
 * @param {number} [nowMs]
 * @returns {Array<object>}
 */
export function parseAlertCaliforniaCatalog(payload, nowMs = Date.now()) {
  const features = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.features)
      ? payload.features
      : [];
  const byId = new Map();
  for (const feature of features) {
    const camera = alertCaliforniaFeatureToSource(feature, nowMs);
    if (camera && !byId.has(camera.id)) byId.set(camera.id, camera);
  }
  return [...byId.values()];
}

/**
 * Load the ALERTCalifornia pack: one catalog request, nearest the
 * California LIVE OPS regions first, capped by CCTV_ALERTCA_MAX_SOURCES.
 * Fails soft to an empty pack.
 */
export async function loadAlertCaliforniaSources(
  _options = {},
  env = process.env,
) {
  const url = String(env.CCTV_ALERTCA_URL || '').trim() || ALERTCA_CATALOG_URL;
  try {
    const resp = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'osiris-cctv-proxy/1.0',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      try {
        await resp.body?.cancel();
      } catch {
        /* no-op */
      }
      throw new Error(
        resp.status >= 300 && resp.status < 400
          ? 'redirected; redirects are not followed'
          : `HTTP ${resp.status}`,
      );
    }
    const payload = await readResponseJsonCapped(
      resp,
      ALERTCA_MAX_CATALOG_BYTES,
    );
    const cameras = parseAlertCaliforniaCatalog(payload);
    const maxRaw = Number(
      env.CCTV_ALERTCA_MAX_SOURCES || DEFAULT_ALERTCA_MAX_SOURCES,
    );
    const maxCount = Number.isFinite(maxRaw)
      ? Math.max(8, Math.min(1500, Math.floor(maxRaw)))
      : DEFAULT_ALERTCA_MAX_SOURCES;
    const prioritized = prioritizeSources(cameras, maxCount, ALERTCA_ANCHORS);
    console.log(
      `[CCTV] Loaded ALERTCalifornia camera sources: ${cameras.length} with a recent frame (using nearest ${prioritized.length})`,
    );
    return prioritized;
  } catch (error) {
    console.warn(
      '[CCTV] ALERTCalifornia camera download error:',
      error?.message || error,
    );
    return [];
  }
}
