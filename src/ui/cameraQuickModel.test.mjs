import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CAMERA_QUICK_LIST_LIMIT,
  cameraDistanceParts,
  cameraIsLive,
  cameraMatchesQuery,
  normalizeCameraQuery,
  quickListKeyAction,
  rankQuickCameras,
} from './cameraQuickModel.js';
import { liveOpsRegion } from '../data/liveOpsRegions.js';

const DOWNTOWN_LA = { lat: 34.0537, lon: -118.2428 };

const camera = (id, lat, lon, extra = {}) => ({
  id,
  name: id,
  city: 'Los Angeles',
  provider: 'Caltrans',
  lat,
  lon,
  feedType: 'image',
  ...extra,
});

const CATALOG = [
  camera('far-still', 34.4, -118.9),
  camera('near-live', 34.06, -118.25, {
    name: 'US-101 at Alameda',
    feedType: 'hls',
    isVideo: true,
  }),
  camera('near-still', 34.05, -118.24, { name: 'I-110 at 6th' }),
  camera('mid-still', 34.1, -118.3, { name: 'Hwy 101 at Vermont' }),
  camera('vegas', 36.1, -115.17, {
    name: 'Las Vegas Blvd (The Strip)',
    city: 'Las Vegas',
    provider: 'Nevada 511',
  }),
  camera('bay-bridge', 37.8, -122.37, {
    name: 'I-80 Bay Bridge',
    city: 'San Francisco',
    feedType: 'hls',
  }),
  camera('no-position', NaN, NaN),
];

test('a search narrows by name, city or provider, every token, accents folded', () => {
  assert.deepEqual(normalizeCameraQuery('  Bay   Bridge '), ['bay', 'bridge']);
  assert.deepEqual(normalizeCameraQuery('Pétaluma'), ['petaluma']);
  assert.deepEqual(normalizeCameraQuery(''), []);
  const tokens = (text) => normalizeCameraQuery(text);
  assert.equal(cameraMatchesQuery(CATALOG[1], tokens('101')), true);
  assert.equal(cameraMatchesQuery(CATALOG[3], tokens('101')), true);
  assert.equal(cameraMatchesQuery(CATALOG[2], tokens('101')), false);
  assert.equal(cameraMatchesQuery(CATALOG[5], tokens('bay bridge')), true);
  assert.equal(cameraMatchesQuery(CATALOG[5], tokens('bridge bay')), true);
  assert.equal(cameraMatchesQuery(CATALOG[5], tokens('bay tunnel')), false);
  assert.equal(cameraMatchesQuery(CATALOG[4], tokens('strip')), true);
  assert.equal(cameraMatchesQuery(CATALOG[4], tokens('nevada')), true);
  assert.equal(cameraMatchesQuery(CATALOG[4], tokens('')), true);
  assert.equal(cameraMatchesQuery(null, tokens('x')), false);
});

test('live is any moving-picture feed, by flag or feed type', () => {
  assert.equal(cameraIsLive({ feedType: 'hls' }), true);
  assert.equal(cameraIsLive({ feedType: 'mjpeg' }), true);
  assert.equal(cameraIsLive({ feedType: 'image', isVideo: true }), true);
  assert.equal(cameraIsLive({ feedType: 'image' }), false);
  assert.equal(cameraIsLive(null), false);
});

test('nearest order keeps the closest cameras to the view centre, nothing without a position', () => {
  const rows = rankQuickCameras({
    cameras: CATALOG,
    center: DOWNTOWN_LA,
    order: 'nearest',
    limit: 3,
  });
  assert.deepEqual(
    rows.map((row) => row.camera.id),
    ['near-still', 'near-live', 'mid-still'],
  );
  assert.equal(rows.total, 6);
  assert.ok(rows[0].distanceKm < rows[1].distanceKm);
  assert.ok(rows[1].distanceKm < rows[2].distanceKm);
  assert.equal(rows[1].live, true);
});

test('newest order lists live feeds first, then the freshest stills, within the nearest set', () => {
  const frames = new Map([
    ['near-still', { stamp: 1_000 }],
    ['mid-still', { stamp: 5_000 }],
  ]);
  const rows = rankQuickCameras({
    cameras: CATALOG,
    center: DOWNTOWN_LA,
    order: 'newest',
    limit: 4,
    frames,
  });
  // The set is the four nearest (the Bay Bridge is not in it even though it
  // is live); the order within it is live, newest still, older still, no frame.
  assert.deepEqual(
    rows.map((row) => row.camera.id),
    ['near-live', 'mid-still', 'near-still', 'far-still'],
  );
  assert.deepEqual(
    rows.map((row) => row.frameStamp),
    [0, 5_000, 1_000, 0],
  );
});

test('a region box and a query both narrow the candidates; total counts the candidates', () => {
  const vegas = rankQuickCameras({
    cameras: CATALOG,
    center: DOWNTOWN_LA,
    region: liveOpsRegion('las-vegas'),
  });
  assert.deepEqual(
    vegas.map((row) => row.camera.id),
    ['vegas'],
  );
  assert.equal(vegas.total, 1);
  const bridge = rankQuickCameras({
    cameras: CATALOG,
    center: DOWNTOWN_LA,
    query: 'Bay Bridge',
  });
  assert.deepEqual(
    bridge.map((row) => row.camera.id),
    ['bay-bridge'],
  );
  const none = rankQuickCameras({
    cameras: CATALOG,
    center: DOWNTOWN_LA,
    query: 'golden gate',
  });
  assert.equal(none.length, 0);
  assert.equal(none.total, 0);
});

test('without a view centre every distance is unknown and catalog order breaks ties', () => {
  const rows = rankQuickCameras({ cameras: CATALOG, order: 'nearest' });
  assert.equal(rows.length, 6);
  assert.ok(rows.every((row) => row.distanceKm === Infinity));
  assert.equal(cameraDistanceParts(rows[0].distanceKm), null);
});

test('the default limit bounds the list', () => {
  const many = Array.from({ length: 60 }, (_, i) =>
    camera(`c${i}`, 34 + i * 0.001, -118.2),
  );
  const rows = rankQuickCameras({ cameras: many, center: DOWNTOWN_LA });
  assert.equal(rows.length, CAMERA_QUICK_LIST_LIMIT);
  assert.equal(rows.total, 60);
});

test('keyboard: arrows move within bounds, Enter opens the highlighted or first row, Escape clears then closes', () => {
  assert.deepEqual(quickListKeyAction('ArrowDown', { index: -1, count: 3 }), {
    type: 'move',
    index: 0,
  });
  assert.deepEqual(quickListKeyAction('ArrowDown', { index: 2, count: 3 }), {
    type: 'move',
    index: 2,
  });
  assert.deepEqual(quickListKeyAction('ArrowUp', { index: 0, count: 3 }), {
    type: 'move',
    index: 0,
  });
  assert.deepEqual(quickListKeyAction('End', { index: 0, count: 3 }), {
    type: 'move',
    index: 2,
  });
  assert.deepEqual(quickListKeyAction('Home', { index: 2, count: 3 }), {
    type: 'move',
    index: 0,
  });
  assert.deepEqual(quickListKeyAction('Enter', { index: 1, count: 3 }), {
    type: 'open',
    index: 1,
  });
  assert.deepEqual(quickListKeyAction('Enter', { index: -1, count: 3 }), {
    type: 'open',
    index: 0,
  });
  assert.equal(quickListKeyAction('Enter', { index: -1, count: 0 }), null);
  assert.equal(quickListKeyAction('ArrowDown', { count: 0 }), null);
  assert.deepEqual(quickListKeyAction('Escape', { hasQuery: true }), {
    type: 'clear',
  });
  assert.deepEqual(quickListKeyAction('Escape', { hasQuery: false }), {
    type: 'close',
  });
  assert.equal(quickListKeyAction('a', { count: 3 }), null);
});

test('distances read as metres under a kilometre, one decimal under ten', () => {
  assert.deepEqual(cameraDistanceParts(0.347), { value: '350', unit: 'm' });
  assert.deepEqual(cameraDistanceParts(0.004), { value: '10', unit: 'm' });
  assert.deepEqual(cameraDistanceParts(1.24), { value: '1.2', unit: 'km' });
  assert.deepEqual(cameraDistanceParts(12.4), { value: '12', unit: 'km' });
  assert.equal(cameraDistanceParts(Infinity), null);
  assert.equal(cameraDistanceParts(-1), null);
});
