import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GRID_SPACING_LADDER_DEG,
  chooseGridSpacing,
  decimalsFor,
  extentOfSamples,
  formatGridDegrees,
  gridCellCenters,
  gridLines,
  gridSpanDeg,
  gridSteps,
  mgrsPrecisionForSpacing,
  normalizeExtent,
  orthographicFov,
  orthographicFovy,
  wrapLongitude,
} from './gridViewMath.js';

test('the spacing ladder is descending and the choice keeps at least the target line count', () => {
  for (let i = 1; i < GRID_SPACING_LADDER_DEG.length; i += 1)
    assert.ok(GRID_SPACING_LADDER_DEG[i] < GRID_SPACING_LADDER_DEG[i - 1]);
  assert.equal(
    chooseGridSpacing(90),
    10,
    'a continent-wide view draws 10° lines',
  );
  assert.equal(chooseGridSpacing(1.2), 0.2);
  assert.equal(chooseGridSpacing(0.08), 0.01);
  assert.equal(
    chooseGridSpacing(0.0001),
    0.001,
    'the finest spacing is the floor',
  );
  assert.equal(chooseGridSpacing(0), null);
  assert.equal(chooseGridSpacing(Number.NaN), null);
  assert.equal(chooseGridSpacing(10, { targetLines: 2 }), 5);
});

test('grid steps are exact multiples inside the range, inclusive and capped', () => {
  assert.deepEqual(gridSteps(-0.3, 0.72, 0.25), [-0.25, 0, 0.25, 0.5]);
  assert.deepEqual(gridSteps(37, 38, 0.5), [37, 37.5, 38]);
  assert.deepEqual(
    gridSteps(0.1, 0.1, 0.1),
    [0.1],
    'a line on the edge counts',
  );
  assert.deepEqual(gridSteps(5, 4, 1), []);
  assert.deepEqual(gridSteps(0, 1, 0), []);
  assert.equal(gridSteps(0, 1000, 1, 10).length, 10);
  assert.equal(decimalsFor(0.25), 2);
  assert.equal(decimalsFor(1), 0);
  assert.equal(decimalsFor(0.005), 3);
});

test('extents are clamped to the globe and unwrapped across the antimeridian', () => {
  assert.deepEqual(
    normalizeExtent({ west: -1, south: -95, east: 1, north: 95 }),
    {
      west: -1,
      east: 1,
      south: -90,
      north: 90,
    },
  );
  const crossing = normalizeExtent({
    west: 179,
    south: 0,
    east: -179,
    north: 1,
  });
  assert.equal(crossing.east, 181);
  assert.equal(wrapLongitude(181), -179);
  assert.equal(wrapLongitude(-180), -180);
  assert.equal(wrapLongitude(180), -180);
  assert.equal(wrapLongitude(540), -180);
});

test('grid lines cover the extent and the span scales longitude by latitude', () => {
  const rect = { west: -122.52, south: 37.7, east: -122.35, north: 37.83 };
  const lines = gridLines(rect, 0.05);
  assert.deepEqual(lines.parallels, [37.7, 37.75, 37.8]);
  assert.deepEqual(lines.meridians, [-122.5, -122.45, -122.4, -122.35]);
  const span = gridSpanDeg(rect);
  assert.ok(
    span < 0.13 && span > 0.12,
    `longitude span is scaled by cos(lat): ${span}`,
  );
  const polar = gridSpanDeg({ west: 0, south: 80, east: 10, north: 81 });
  assert.ok(polar <= 1, 'the shorter axis wins');
});

test('degree labels carry the hemisphere and the decimals of the spacing', () => {
  assert.equal(formatGridDegrees(37.75, 'lat', 0.25), '37.75°N');
  assert.equal(formatGridDegrees(-33.9, 'lat', 0.1), '33.9°S');
  assert.equal(formatGridDegrees(-122.4, 'lon', 0.2), '122.4°W');
  assert.equal(
    formatGridDegrees(181, 'lon', 1),
    '179°W',
    'unwrapped meridians wrap back',
  );
  assert.equal(formatGridDegrees(0, 'lon', 1), '0°');
  assert.equal(
    formatGridDegrees(-0.001, 'lat', 1),
    '0°',
    'rounding to zero drops the hemisphere',
  );
});

test('MGRS precision follows the spacing', () => {
  assert.equal(mgrsPrecisionForSpacing(10), 1);
  assert.equal(mgrsPrecisionForSpacing(0.5), 2);
  assert.equal(mgrsPrecisionForSpacing(0.02), 3);
  assert.equal(mgrsPrecisionForSpacing(0.001), 4);
});

test('cell centres sit between lines, stay inside the extent and thin out when dense', () => {
  const rect = { west: 0, south: 0, east: 1, north: 1 };
  const cells = gridCellCenters(rect, 0.5);
  assert.deepEqual(cells.map((cell) => `${cell.lat},${cell.lon}`).sort(), [
    '0.25,0.25',
    '0.25,0.75',
    '0.75,0.25',
    '0.75,0.75',
  ]);
  const partial = gridCellCenters(
    { west: 0.1, south: 0.1, east: 0.9, north: 0.9 },
    0.5,
  );
  assert.deepEqual(
    partial.map((cell) => `${cell.lat},${cell.lon}`).sort(),
    ['0.25,0.25', '0.25,0.75', '0.75,0.25', '0.75,0.75'],
    'cells cut by the edge are still labelled at their centre',
  );
  const dense = gridCellCenters(rect, 0.05, { maxCells: 48 });
  assert.ok(
    dense.length <= 48 * 1.2,
    `dense grids label a stride: ${dense.length}`,
  );
  assert.ok(dense.length >= 40, 'but still label most of the view');
  assert.deepEqual(gridCellCenters(rect, 0), []);
  const crossing = gridCellCenters(
    { west: 179.5, south: 0, east: -179.5, north: 0.5 },
    0.5,
  );
  assert.deepEqual(crossing, [
    { lat: 0.25, lon: 179.75 },
    { lat: 0.25, lon: -179.75 },
  ]);
});

test('an extent is read off ground samples, with sky samples ignored', () => {
  const extent = extentOfSamples([
    { lat: 37.7, lon: -122.5 },
    null,
    { lat: 37.8, lon: -122.4 },
    { lat: 37.75, lon: -122.45 },
    { lat: Number.NaN, lon: 1 },
  ]);
  assert.deepEqual(extent, {
    west: -122.5,
    east: -122.4,
    south: 37.7,
    north: 37.8,
  });
  assert.equal(
    extentOfSamples([
      { lat: 1, lon: 1 },
      { lat: 2, lon: 2 },
    ]),
    null,
  );
  assert.equal(
    extentOfSamples(
      [
        { lat: 1, lon: 1 },
        { lat: 2, lon: 2 },
      ],
      { minimum: 2 },
    )?.north,
    2,
  );
  const crossing = extentOfSamples([
    { lat: 0, lon: 179 },
    { lat: 1, lon: -179 },
    { lat: 0.5, lon: 180 },
  ]);
  assert.deepEqual(crossing, { west: 179, east: 181, south: 0, north: 1 });
});

test('the orthographic field of view matches the perspective camera that shows the same ground', () => {
  // A 2000 m wide, 16:9 frustum seen from 1000 m: the ground height is 1125 m,
  // which a perspective camera covers with 2·atan(562.5 / 1000).
  const fovy = orthographicFovy(2000, 16 / 9, 1000);
  assert.ok(Math.abs(fovy - 2 * Math.atan(562.5 / 1000)) < 1e-12);
  const fov = orthographicFov(fovy, 16 / 9);
  assert.ok(
    Math.abs(fov - 2 * Math.atan(1000 / 1000)) < 1e-12,
    'the horizontal angle covers the width',
  );
  assert.equal(orthographicFovy(0, 1, 10), null);
  assert.equal(orthographicFovy(10, 1, 0), null);
  assert.equal(orthographicFovy(10, Number.NaN, 10), null);
});
