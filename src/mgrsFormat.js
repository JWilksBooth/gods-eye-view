/**
 * MGRS readouts shared by the HUD and the grid view. Pure: the `mgrs`
 * package does the projection, this module only shapes the text.
 * @module mgrsFormat
 */
import * as mgrsModule from 'mgrs';

// The bundler resolves the package's ES module (named exports); Node resolves
// its CommonJS build, whose exports arrive as the default. Unit tests run the
// latter, so both shapes are accepted.
const toMGRS = mgrsModule.forward ?? mgrsModule.default?.forward;

/**
 * Insert spaces into a raw MGRS string for human-readable display:
 * `18SUJ23370716` → `18S UJ 2337 0716`. Anything that is not an MGRS
 * reference is returned unchanged.
 * @param {string} mgrs Raw MGRS string.
 * @returns {string}
 */
export function formatMGRS(mgrs) {
  // Grid zone designator (1-2 digits + band letter), 100 km square id (two
  // letters), then the numeric easting and northing split in half.
  const match = String(mgrs ?? '').match(
    /^(\d{1,2}[A-Z])\s*([A-Z]{2})\s*(\d+)$/,
  );
  if (!match) return mgrs;
  const [, zone, square, coords] = match;
  const half = coords.length / 2;
  return `${zone} ${square} ${coords.slice(0, half)} ${coords.slice(half)}`;
}

/**
 * The formatted MGRS reference of a point, or null where MGRS is undefined
 * (the polar caps) or the input is not a position.
 * @param {number} lon Degrees.
 * @param {number} lat Degrees.
 * @param {number} [precision=4] Digits per coordinate: 5 is 1 m, 4 is 10 m,
 *   3 is 100 m, 2 is 1 km, 1 is 10 km.
 * @returns {string|null}
 */
export function mgrsAt(lon, lat, precision = 4) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (Math.abs(lat) > 84) return null;
  try {
    return formatMGRS(toMGRS([lon, lat], precision));
  } catch {
    return null;
  }
}
