import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALERTCA_CATALOG_URL,
  ALERTCA_CREDIT,
  alertCaliforniaCountyLabel,
  alertCaliforniaFeatureToSource,
  alertCaliforniaFrameUrl,
  loadAlertCaliforniaSources,
  parseAlertCaliforniaCatalog,
} from './alertcalifornia.js';

/* Three records as the public catalog serves them (2026-11-02), trimmed. */
const NOW_S = 1793581700;
const NOW_MS = NOW_S * 1000;

const ALLEN_PEAK = {
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [-122.294601, 37.386902, 706] },
  properties: {
    id: 'allenpeak-cam01',
    name: 'Allen Peak',
    stream_ids: ['Axis-AllenPeak'],
    fov_lft: [-122.1148180224084, 37.135497012484024],
    fov_rt: [-122.48108004624244, 37.13859542058343],
    fov_center: [-122.29847539983321, 37.09776481928498],
    fov: 60.43,
    ProdNbr: 'Q6075-E',
    az_current: 180.61,
    tilt_current: -1.72,
    zoom_current: 55,
    ptz_updated_ts: 1793581646,
    state: 'CA',
    county: 'sanmateo',
    isp: 'ridgewireless',
    sponsor: 'calfire',
    region: 'CZU',
    last_frame_ts: 1793581666,
  },
};

/* The second camera on a shared mast reports no PTZ readout. */
const ALMADEN_2 = {
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [-121.847187, 37.194245, 180] },
  properties: {
    id: 'almaden-cam02',
    name: 'Almaden 2',
    stream_ids: ['Axis-Almaden2'],
    fov_lft: [-122.04248788337429, 37.43797897398719],
    fov_rt: [-121.65188611662572, 37.43797897398719],
    fov_center: [-121.847187, 37.483398568070065],
    fov: 65.1,
    ProdNbr: 'Q6075-E',
    az_current: null,
    tilt_current: null,
    zoom_current: null,
    ptz_updated_ts: null,
    state: 'CA',
    county: 'santaclara',
    isp: 'digitalpath',
    sponsor: 'pge',
    region: 'SCU',
    last_frame_ts: 1793581670,
  },
};

const STALE = {
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [-118.5, 34.2, 900] },
  properties: {
    id: 'dead-cam01',
    name: 'Dead',
    fov: 60,
    az_current: 90,
    tilt_current: -5,
    county: 'losangeles',
    last_frame_ts: NOW_S - 3 * 24 * 3600,
  },
};

test('a catalog feature becomes a credited, host-pinned still camera with its PTZ pose', () => {
  const camera = alertCaliforniaFeatureToSource(ALLEN_PEAK, NOW_MS);
  assert.equal(camera.id, 'alertca-allenpeak-cam01');
  assert.equal(camera.name, 'Allen Peak');
  assert.equal(camera.city, 'San Mateo County');
  assert.equal(camera.provider, 'ALERTCalifornia');
  assert.equal(camera.credit, ALERTCA_CREDIT);
  assert.equal(
    camera.url,
    'https://cameras.alertcalifornia.org/public-camera-data/allenpeak-cam01/latest-frame.jpg',
  );
  assert.equal(camera.snapshotUrl, camera.url);
  assert.equal(camera.feedType, 'image');
  assert.equal(camera.sourceKind, 'alertcalifornia');
  assert.equal(camera.lat, 37.386902);
  assert.equal(camera.lon, -122.294601);
  assert.equal(camera.groundElevationM, 706);
  assert.equal(camera.headingDeg, 180.61);
  assert.equal(camera.headingConfidence, 'high');
  assert.equal(camera.fovDeg, 60.43);
  // Tilt -1.72 is above the pose floor; the camera looks a touch down.
  assert.equal(camera.pitchDeg, -2);
  // The view cone's centre is 32 km out; the client's catalog range tops at 2.2 km.
  assert.equal(camera.rangeM, 2200);
  assert.equal(camera.model, 'Q6075-E');
  assert.equal(camera.manufacturer, 'Axis');
  assert.match(camera.license, /CC BY-NC-ND 4\.0/);
});

test('without a PTZ readout the view cone gives the bearing at medium confidence', () => {
  const camera = alertCaliforniaFeatureToSource(ALMADEN_2, NOW_MS);
  assert.equal(camera.id, 'alertca-almaden-cam02');
  assert.equal(camera.city, 'Santa Clara County');
  // fov_center sits due north of the mast.
  assert.ok(Math.abs(camera.headingDeg - 0) < 0.5 || Math.abs(camera.headingDeg - 360) < 0.5);
  assert.equal(camera.headingConfidence, 'medium');
  assert.equal(camera.pitchDeg, -4);
});

test('stale, unplaced and oddly named cameras are dropped', () => {
  assert.equal(alertCaliforniaFeatureToSource(STALE, NOW_MS), null);
  assert.equal(
    alertCaliforniaFeatureToSource(
      {
        ...ALLEN_PEAK,
        geometry: { type: 'Point', coordinates: ['x', null] },
      },
      NOW_MS,
    ),
    null,
  );
  assert.equal(
    alertCaliforniaFeatureToSource(
      { ...ALLEN_PEAK, properties: { ...ALLEN_PEAK.properties, id: '../etc' } },
      NOW_MS,
    ),
    null,
  );
  assert.equal(
    alertCaliforniaFeatureToSource(
      {
        ...ALLEN_PEAK,
        properties: { ...ALLEN_PEAK.properties, last_frame_ts: undefined },
      },
      NOW_MS,
    ),
    null,
  );
  assert.equal(alertCaliforniaFrameUrl('bad id'), null);
  assert.equal(alertCaliforniaFrameUrl(''), null);
});

test('county labels expand the catalog spellings', () => {
  assert.equal(alertCaliforniaCountyLabel('contracosta'), 'Contra Costa County');
  assert.equal(alertCaliforniaCountyLabel('losangeles'), 'Los Angeles County');
  assert.equal(alertCaliforniaCountyLabel('sonoma'), 'Sonoma County');
  assert.equal(alertCaliforniaCountyLabel(''), '');
});

test('a FeatureCollection parses in order with duplicates dropped', () => {
  const cameras = parseAlertCaliforniaCatalog(
    { type: 'FeatureCollection', features: [ALLEN_PEAK, ALMADEN_2, ALLEN_PEAK, STALE] },
    NOW_MS,
  );
  assert.deepEqual(
    cameras.map((camera) => camera.id),
    ['alertca-allenpeak-cam01', 'alertca-almaden-cam02'],
  );
  assert.deepEqual(parseAlertCaliforniaCatalog({ nope: true }, NOW_MS), []);
});

test('the loader fetches the catalog once, ranks nearest the California regions and caps', async (t) => {
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  t.mock.method(console, 'warn', (...args) => lines.push(args.join(' ')));
  const requested = [];
  const features = [
    ALLEN_PEAK,
    ALMADEN_2,
    {
      ...ALLEN_PEAK,
      geometry: { type: 'Point', coordinates: [-110.7, 43.5, 2000] },
      properties: { ...ALLEN_PEAK.properties, id: 'wyoming-cam01', name: 'Far', state: 'WY', last_frame_ts: Math.floor(Date.now() / 1000) },
    },
  ].map((feature) => ({
    ...feature,
    properties: { ...feature.properties, last_frame_ts: Math.floor(Date.now() / 1000) },
  }));
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requested.push({ url: String(url), init });
    return Response.json({ type: 'FeatureCollection', features });
  });
  const cameras = await loadAlertCaliforniaSources({}, { CCTV_ALERTCA_MAX_SOURCES: '2' });
  assert.equal(requested.length, 1);
  assert.equal(requested[0].url, ALERTCA_CATALOG_URL);
  assert.equal(requested[0].init.redirect, 'manual');
  // The cap floors at eight, so all three stay; the Wyoming camera ranks last.
  assert.deepEqual(
    cameras.map((camera) => camera.id),
    ['alertca-allenpeak-cam01', 'alertca-almaden-cam02', 'alertca-wyoming-cam01'],
  );
  assert.ok(lines.some((line) => line.includes('ALERTCalifornia')));
});

test('an upstream failure or redirect yields an empty pack, never a throw', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 302, headers: { location: 'https://elsewhere.invalid/' } }));
  assert.deepEqual(await loadAlertCaliforniaSources({}, {}), []);
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('offline');
  });
  assert.deepEqual(await loadAlertCaliforniaSources({}, {}), []);
});
