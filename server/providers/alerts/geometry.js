/**
 * Geometry bounds for alert areas: validation, simplification and boxes.
 * Alert polygons are drawn draped on the globe; a National Weather Service
 * zone can carry thousands of vertices, so shapes are simplified to about a
 * kilometre before they leave the server.
 */
import { validateAlertGeometry } from '../../../src/layers/alerts/model.js';

/** Simplification tolerance in degrees (~0.5 km at these latitudes). */
export const ALERT_SIMPLIFY_TOLERANCE_DEG = 0.005;
/** Most vertices kept per ring after simplification. */
export const ALERT_RING_MAX_VERTICES = 400;
/** Most polygons kept per alert; a zone group past this keeps the largest. */
export const ALERT_MAX_POLYGONS = 24;

function perpendicularDistance(point, start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  if (dx === 0 && dy === 0) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  const t = Math.max(
    0,
    Math.min(
      1,
      ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) /
        (dx * dx + dy * dy),
    ),
  );
  return Math.hypot(point[0] - (start[0] + t * dx), point[1] - (start[1] + t * dy));
}

/** Douglas–Peucker over an open or closed ring; keeps the end points. */
export function simplifyRing(ring, tolerance = ALERT_SIMPLIFY_TOLERANCE_DEG) {
  if (!Array.isArray(ring) || ring.length <= 4) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = 1;
  keep[ring.length - 1] = 1;
  const stack = [[0, ring.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let index = -1;
    let max = tolerance;
    for (let i = first + 1; i < last; i++) {
      const distance = perpendicularDistance(ring[i], ring[first], ring[last]);
      if (distance > max) {
        max = distance;
        index = i;
      }
    }
    if (index !== -1) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  const result = ring.filter((_, i) => keep[i]);
  // A ring needs four positions (three distinct); fall back to the original
  // when simplification collapsed it.
  return result.length >= 4 ? result : ring;
}

/** Thin a ring evenly down to `max` vertices, keeping the closing point. */
function capRing(ring, max) {
  if (ring.length <= max) return ring;
  const step = (ring.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max - 1; i++) out.push(ring[Math.round(i * step)]);
  out.push(ring[ring.length - 1]);
  return out;
}

function ringArea(ring) {
  let sum = 0;
  for (let i = 1; i < ring.length; i++) {
    sum += ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1];
  }
  return Math.abs(sum / 2);
}

/**
 * A validated, simplified copy of a Point/Polygon/MultiPolygon, or null.
 * Coordinates are rounded to five decimals (about a metre).
 */
export function simplifyAlertGeometry(
  geometry,
  {
    tolerance = ALERT_SIMPLIFY_TOLERANCE_DEG,
    maxVertices = ALERT_RING_MAX_VERTICES,
    maxPolygons = ALERT_MAX_POLYGONS,
  } = {},
) {
  const valid = validateAlertGeometry(geometry);
  if (!valid) return null;
  const round = ([lon, lat]) => [
    Math.round(lon * 1e5) / 1e5,
    Math.round(lat * 1e5) / 1e5,
  ];
  if (valid.type === 'Point')
    return { type: 'Point', coordinates: round(valid.coordinates) };
  const polygons =
    valid.type === 'Polygon' ? [valid.coordinates] : valid.coordinates;
  const simplified = polygons
    .map((rings) =>
      rings
        .map((ring) => capRing(simplifyRing(ring, tolerance), maxVertices).map(round))
        .filter((ring) => ring.length >= 4),
    )
    .filter((rings) => rings.length > 0)
    .sort((a, b) => ringArea(b[0]) - ringArea(a[0]))
    .slice(0, maxPolygons);
  if (!simplified.length) return null;
  return simplified.length === 1
    ? { type: 'Polygon', coordinates: simplified[0] }
    : { type: 'MultiPolygon', coordinates: simplified };
}

/** Merge several Polygon/MultiPolygon geometries into one MultiPolygon. */
export function mergePolygons(geometries) {
  const polygons = [];
  for (const geometry of geometries || []) {
    const valid = validateAlertGeometry(geometry);
    if (!valid || valid.type === 'Point') continue;
    if (valid.type === 'Polygon') polygons.push(valid.coordinates);
    else polygons.push(...valid.coordinates);
  }
  if (!polygons.length) return null;
  return polygons.length === 1
    ? { type: 'Polygon', coordinates: polygons[0] }
    : { type: 'MultiPolygon', coordinates: polygons };
}
