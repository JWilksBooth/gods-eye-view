import assert from 'node:assert/strict';
import test from 'node:test';
import { suppressPackOverlaps } from '../../server/providers/cctv/cap.js';

const camera = (id, lat, lon) => ({ id, lat, lon });

test('a camera the dropped pack lists within the distance of a kept camera goes; the rest stay', () => {
  const packs = [
    {
      name: 'nvfast',
      sources: [camera('nvfast-1', 36.1003, -115.1725), camera('nvfast-2', 36.2, -115.2)],
      available: 2,
    },
    {
      name: 'nvroads',
      sources: [
        // 40 m east of nvfast-1: the same pole.
        camera('nv-a', 36.1003, -115.17205),
        // 900 m away: a different camera.
        camera('nv-b', 36.108, -115.1725),
        // Reno, nowhere near.
        camera('nv-c', 39.53, -119.81),
        // Unplaced rows are left alone.
        { id: 'nv-d', lat: NaN, lon: NaN },
      ],
      available: 4,
    },
    { name: 'caltrans', sources: [camera('ca-1', 34.05, -118.24)], available: 1 },
  ];
  const changes = suppressPackOverlaps(packs, [
    { keep: 'nvfast', drop: 'nvroads', withinM: 120 },
  ]);
  assert.deepEqual(changes, [{ keep: 'nvfast', drop: 'nvroads', suppressed: 1 }]);
  assert.deepEqual(
    packs[1].sources.map((source) => source.id),
    ['nv-b', 'nv-c', 'nv-d'],
  );
  assert.equal(packs[1].available, 3);
  assert.equal(packs[0].sources.length, 2);
  assert.equal(packs[2].sources.length, 1);
});

test('a rule whose packs are missing or empty changes nothing', () => {
  const packs = [
    { name: 'nvroads', sources: [camera('nv-a', 36.1, -115.1)], available: 1 },
    { name: 'nvfast', sources: [], available: 0 },
  ];
  assert.deepEqual(
    suppressPackOverlaps(packs, [
      { keep: 'nvfast', drop: 'nvroads', withinM: 120 },
      { keep: 'nope', drop: 'nvroads', withinM: 120 },
      { keep: 'nvfast', drop: 'nvroads', withinM: 0 },
    ]),
    [],
  );
  assert.equal(packs[0].sources.length, 1);
  assert.deepEqual(suppressPackOverlaps(packs, null), []);
});

test('neighbouring grid cells are searched, so a pair across a cell edge still matches', () => {
  const cellDeg = 120 / 111_320;
  const lat = Math.ceil(36.1 / cellDeg) * cellDeg;
  const packs = [
    { name: 'nvfast', sources: [camera('f', lat + 0.00001, -115.1)], available: 1 },
    { name: 'nvroads', sources: [camera('r', lat - 0.00001, -115.1)], available: 1 },
  ];
  const changes = suppressPackOverlaps(packs, [
    { keep: 'nvfast', drop: 'nvroads', withinM: 120 },
  ]);
  assert.equal(changes[0].suppressed, 1);
  assert.equal(packs[1].sources.length, 0);
});
