import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ALERT_MAX_POLYGONS,
  ALERT_RING_MAX_VERTICES,
  mergePolygons,
  simplifyAlertGeometry,
  simplifyRing,
} from './geometry.js';

const circle = (lon, lat, radius, points) => {
  const ring = [];
  for (let i = 0; i < points; i += 1) {
    const angle = (i / points) * 2 * Math.PI;
    ring.push([lon + radius * Math.cos(angle), lat + radius * Math.sin(angle)]);
  }
  ring.push(ring[0]);
  return ring;
};

test('rings simplify within tolerance and stay closed rings', () => {
  const line = [
    [0, 0],
    [1, 0.0001],
    [2, 0],
    [2, 2],
    [0, 0],
  ];
  assert.deepEqual(simplifyRing(line, 0.01), [
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 0],
  ]);
  const tiny = [
    [0, 0],
    [0.0001, 0],
    [0.0001, 0.0001],
    [0, 0],
  ];
  assert.deepEqual(simplifyRing(tiny, 1), tiny, 'a ring never collapses');
});

test('zone shapes are validated, capped and rounded before they leave the server', () => {
  const dense = {
    type: 'Polygon',
    coordinates: [circle(-122.4, 37.7, 0.5, 5000)],
  };
  const simplified = simplifyAlertGeometry(dense, { tolerance: 0 });
  const ring = simplified.coordinates[0];
  assert.ok(ring.length <= ALERT_RING_MAX_VERTICES);
  assert.deepEqual(ring[0], ring.at(-1));
  assert.ok(
    ring.every(
      ([lon, lat]) =>
        lon === Math.round(lon * 1e5) / 1e5 &&
        lat === Math.round(lat * 1e5) / 1e5,
    ),
  );
  const many = {
    type: 'MultiPolygon',
    coordinates: Array.from({ length: ALERT_MAX_POLYGONS + 6 }, (_, index) => [
      circle(-120 + index * 0.1, 36, 0.01 + index * 0.001, 12),
    ]),
  };
  const kept = simplifyAlertGeometry(many);
  assert.equal(kept.type, 'MultiPolygon');
  assert.equal(
    kept.coordinates.length,
    ALERT_MAX_POLYGONS,
    'the largest are kept',
  );
  assert.deepEqual(
    simplifyAlertGeometry({ type: 'Point', coordinates: [1.123456789, 2] }),
    {
      type: 'Point',
      coordinates: [1.12346, 2],
    },
  );
  assert.equal(
    simplifyAlertGeometry({ type: 'LineString', coordinates: [] }),
    null,
  );
  assert.equal(
    simplifyAlertGeometry({
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [999, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    }),
    null,
  );
});

test('zone polygons merge into one multipolygon; points are not areas', () => {
  const a = { type: 'Polygon', coordinates: [circle(0, 0, 1, 8)] };
  const b = {
    type: 'MultiPolygon',
    coordinates: [[circle(3, 0, 1, 8)], [circle(6, 0, 1, 8)]],
  };
  assert.equal(mergePolygons([a]).type, 'Polygon');
  const merged = mergePolygons([a, b, { type: 'Point', coordinates: [0, 0] }]);
  assert.equal(merged.type, 'MultiPolygon');
  assert.equal(merged.coordinates.length, 3);
  assert.equal(mergePolygons([]), null);
});
