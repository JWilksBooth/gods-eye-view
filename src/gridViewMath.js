/**
 * Grid view geometry: which graticule lines to draw for a visible extent,
 * how to label them, which MGRS precision suits the spacing, and the
 * perspective-equivalent field of view of an orthographic frustum. Pure: no
 * Cesium, no DOM, so the policy is unit-testable.
 * @module gridViewMath
 */

/** Graticule spacings the grid chooses from, widest first (degrees). */
export const GRID_SPACING_LADDER_DEG = Object.freeze([
  45, 30, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001,
]);

/** The grid aims for at least this many lines across the shorter axis. */
export const GRID_TARGET_LINES = 5;

/** Cells the grid labels with MGRS at most; denser grids label a stride. */
export const GRID_MAX_LABELLED_CELLS = 48;

/** Lines per axis at most; a wider extent takes a wider spacing instead. */
const MAX_LINES_PER_AXIS = 64;

/** Decimal places that write `spacing` exactly (0.25 → 2, 1 → 0). */
export function decimalsFor(spacing) {
  const text = String(spacing);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

/**
 * The widest ladder spacing that still draws `targetLines` lines across a
 * span, or the finest one when even that is too coarse.
 * @param {number} spanDeg
 * @param {{targetLines?: number}} [options]
 * @returns {number|null} null for a non-positive span.
 */
export function chooseGridSpacing(
  spanDeg,
  { targetLines = GRID_TARGET_LINES } = {},
) {
  if (!Number.isFinite(spanDeg) || spanDeg <= 0) return null;
  for (const spacing of GRID_SPACING_LADDER_DEG) {
    if (spanDeg / spacing >= targetLines) return spacing;
  }
  return GRID_SPACING_LADDER_DEG.at(-1);
}

/**
 * Multiples of `spacing` inside [min, max], inclusive and capped.
 * @param {number} min
 * @param {number} max
 * @param {number} spacing
 * @param {number} [cap]
 * @returns {number[]}
 */
export function gridSteps(min, max, spacing, cap = MAX_LINES_PER_AXIS) {
  if (
    !(spacing > 0) ||
    !Number.isFinite(min) ||
    !Number.isFinite(max) ||
    max < min
  )
    return [];
  const decimals = decimalsFor(spacing);
  const steps = [];
  const first = Math.ceil(min / spacing - 1e-9);
  const last = Math.floor(max / spacing + 1e-9);
  for (let index = first; index <= last && steps.length < cap; index += 1) {
    steps.push(Number((index * spacing).toFixed(decimals)));
  }
  return steps;
}

/** Longitude wrapped into [-180, 180). */
export function wrapLongitude(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/**
 * Unwrap an extent that crosses the antimeridian so east is numerically
 * greater than west; latitudes are clamped to the globe.
 * @param {{west: number, south: number, east: number, north: number}} rect Degrees.
 */
export function normalizeExtent(rect) {
  const west = rect.west;
  const east = rect.east < rect.west ? rect.east + 360 : rect.east;
  return {
    west,
    east,
    south: Math.max(-90, rect.south),
    north: Math.min(90, rect.north),
  };
}

/**
 * The parallels and meridians to draw for an extent at a spacing. Meridians
 * are returned unwrapped (continuous across the antimeridian) so a caller
 * can sample a line from `south` to `north` at that longitude; wrap them
 * with {@link wrapLongitude} for labels.
 * @param {{west: number, south: number, east: number, north: number}} rect
 * @param {number} spacing Degrees.
 * @returns {{parallels: number[], meridians: number[]}}
 */
export function gridLines(rect, spacing) {
  const extent = normalizeExtent(rect);
  return {
    parallels: gridSteps(extent.south, extent.north, spacing),
    meridians: gridSteps(extent.west, extent.east, spacing),
  };
}

/**
 * The shorter angular span of an extent, with the longitude span scaled by
 * the cosine of the mid-latitude so east-west and north-south lines read
 * with similar density.
 * @param {{west: number, south: number, east: number, north: number}} rect
 * @returns {number} Degrees.
 */
export function gridSpanDeg(rect) {
  const extent = normalizeExtent(rect);
  const midLat = ((extent.north + extent.south) / 2) * (Math.PI / 180);
  const lonSpan = (extent.east - extent.west) * Math.max(0.1, Math.cos(midLat));
  return Math.min(extent.north - extent.south, lonSpan);
}

/**
 * A degree label for a grid line: `37.75°N`, `122.4°W`, with the decimals
 * the spacing needs and no more.
 * @param {number} value Degrees (longitudes may be unwrapped).
 * @param {'lat'|'lon'} axis
 * @param {number} spacing
 * @returns {string}
 */
export function formatGridDegrees(value, axis, spacing) {
  const degrees = axis === 'lon' ? wrapLongitude(value) : value;
  const text = Math.abs(degrees).toFixed(decimalsFor(spacing));
  const positive = axis === 'lat' ? 'N' : 'E';
  const negative = axis === 'lat' ? 'S' : 'W';
  const hemisphere =
    Number(text) === 0 ? '' : degrees < 0 ? negative : positive;
  return `${text}°${hemisphere}`;
}

/**
 * MGRS digits per coordinate that match a graticule spacing: 10 km squares
 * for degree grids, down to 10 m for the finest.
 * @param {number} spacing Degrees.
 * @returns {1|2|3|4}
 */
export function mgrsPrecisionForSpacing(spacing) {
  if (spacing >= 1) return 1;
  if (spacing >= 0.1) return 2;
  if (spacing >= 0.01) return 3;
  return 4;
}

/**
 * Centres of the grid cells inside an extent, for MGRS labels. When the
 * extent holds more than `maxCells` cells every n-th cell on each axis is
 * labelled, so a dense grid never fills the screen with text.
 * @param {{west: number, south: number, east: number, north: number}} rect
 * @param {number} spacing Degrees.
 * @param {{maxCells?: number}} [options]
 * @returns {Array<{lat: number, lon: number}>} Longitudes wrapped.
 */
export function gridCellCenters(
  rect,
  spacing,
  { maxCells = GRID_MAX_LABELLED_CELLS } = {},
) {
  if (!(spacing > 0)) return [];
  const extent = normalizeExtent(rect);
  const half = spacing / 2;
  const centersBetween = (min, max) =>
    gridSteps(min - spacing, max, spacing, MAX_LINES_PER_AXIS + 1)
      .map((line) => line + half)
      .filter((center) => center > min && center < max);
  const lats = centersBetween(extent.south, extent.north);
  const lons = centersBetween(extent.west, extent.east);
  const total = lats.length * lons.length;
  const stride =
    total > maxCells ? Math.ceil(Math.sqrt(total / Math.max(1, maxCells))) : 1;
  const cells = [];
  for (let i = 0; i < lats.length; i += stride) {
    for (let j = 0; j < lons.length; j += stride) {
      cells.push({ lat: lats[i], lon: wrapLongitude(lons[j]) });
    }
  }
  return cells;
}

/**
 * The extent covered by sampled ground points, or null when too few of the
 * samples hit the globe (the view reaches past the limb).
 * @param {Array<{lat: number, lon: number}|null>} points Degrees.
 * @param {{minimum?: number}} [options]
 * @returns {{west: number, south: number, east: number, north: number}|null}
 */
export function extentOfSamples(points, { minimum = 3 } = {}) {
  const valid = (points || []).filter(
    (point) =>
      point && Number.isFinite(point.lat) && Number.isFinite(point.lon),
  );
  if (valid.length < minimum) return null;
  let lons = valid.map((point) => point.lon);
  const lats = valid.map((point) => point.lat);
  // Across the antimeridian the raw longitudes straddle ±180; unwrap them.
  if (Math.max(...lons) - Math.min(...lons) > 180)
    lons = lons.map((lon) => (lon < 0 ? lon + 360 : lon));
  return {
    west: Math.min(...lons),
    east: Math.max(...lons),
    south: Math.min(...lats),
    north: Math.max(...lats),
  };
}

/**
 * The vertical field of view a perspective camera would need to show the
 * same ground height as an orthographic frustum from `distance` metres
 * away. Pixel math written for `frustum.fovy` keeps working through it.
 * @param {number} width Orthographic frustum width (metres).
 * @param {number} aspectRatio Frustum aspect ratio (width / height).
 * @param {number} distance Camera distance to the ground (metres).
 * @returns {number|null} Radians, or null for degenerate input.
 */
export function orthographicFovy(width, aspectRatio, distance) {
  if (!(width > 0) || !(aspectRatio > 0) || !(distance > 0)) return null;
  return 2 * Math.atan(width / aspectRatio / (2 * distance));
}

/**
 * The horizontal field of view matching a vertical one at an aspect ratio.
 * @param {number} fovy Radians.
 * @param {number} aspectRatio
 * @returns {number} Radians.
 */
export function orthographicFov(fovy, aspectRatio) {
  return 2 * Math.atan(Math.tan(fovy / 2) * Math.max(1e-6, aspectRatio));
}
