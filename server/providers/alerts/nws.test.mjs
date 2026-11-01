import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createNwsFeedSource,
  createNwsZoneCache,
  draftNwsAlert,
  nwsAlertKind,
  nwsAlertLink,
  regionsTouchedBy,
} from './nws.js';

const NOW = Date.parse('2026-11-01T17:00:00Z');

const square = (lon, lat, size = 0.1) => ({
  type: 'Polygon',
  coordinates: [
    [
      [lon, lat],
      [lon + size, lat],
      [lon + size, lat + size],
      [lon, lat + size],
      [lon, lat],
    ],
  ],
});

const feature = (id, properties, geometry = null) => ({
  id: `https://api.weather.gov/alerts/${id}`,
  type: 'Feature',
  geometry,
  properties: {
    '@id': `https://api.weather.gov/alerts/${id}`,
    id,
    status: 'Actual',
    messageType: 'Alert',
    severity: 'Moderate',
    senderName: 'NWS Fixture Office',
    sent: '2026-11-01T15:00:00Z',
    effective: '2026-11-01T15:00:00Z',
    expires: '2026-11-01T23:00:00Z',
    ends: '2026-11-02T03:00:00Z',
    headline: 'Fixture headline',
    description: 'Fixture description.',
    instruction: 'Fixture instruction.',
    geocode: { SAME: [], UGC: [] },
    affectedZones: [],
    parameters: {},
    ...properties,
  },
});

const FEATURES = {
  CA: [
    feature(
      'urn:la-flash-flood',
      {
        event: 'Flash Flood Warning',
        severity: 'Severe',
        areaDesc: 'Los Angeles, CA',
        geocode: { SAME: ['006037'], UGC: ['CAC037'] },
        parameters: { AWIPSidentifier: ['FFWLOX'] },
      },
      square(-118.3, 34.0),
    ),
    feature('urn:sf-coastal', {
      event: 'Coastal Flood Advisory',
      severity: 'Minor',
      areaDesc: 'San Francisco Bay Shoreline',
      geocode: { SAME: ['006075'], UGC: ['CAZ006'] },
      affectedZones: ['https://api.weather.gov/zones/forecast/CAZ006'],
    }),
    feature(
      'urn:ventura-only',
      {
        event: 'Flood Advisory',
        severity: 'Minor',
        geocode: { SAME: ['006111'], UGC: ['CAC111'] },
      },
      square(-119.35, 34.25),
    ),
    feature('urn:sonoma-only', {
      event: 'Beach Hazards Statement',
      geocode: { SAME: ['006097'], UGC: ['CAZ505'] },
      affectedZones: ['https://api.weather.gov/zones/forecast/CAZ505'],
    }),
    feature('urn:elsewhere', {
      event: 'Wind Advisory',
      geocode: { SAME: ['006019'], UGC: ['CAZ300'] },
    }),
    feature('urn:test', {
      event: 'Test Message',
      geocode: { SAME: ['006075'], UGC: ['CAZ006'] },
    }),
    feature('urn:exercise', {
      status: 'Exercise',
      event: 'Wind Advisory',
      geocode: { SAME: ['006075'] },
    }),
    feature('urn:cancelled', {
      messageType: 'Cancel',
      event: 'Wind Advisory',
      geocode: { SAME: ['006075'] },
    }),
    feature('urn:expired', {
      event: 'Wind Advisory',
      ends: '2026-11-01T16:00:00Z',
      geocode: { SAME: ['006075'] },
    }),
  ],
  NV: [
    feature('urn:clark-flood', {
      event: 'Flood Watch',
      severity: 'Severe',
      senderName: 'NWS Las Vegas NV',
      geocode: { SAME: ['032003'], UGC: ['NVZ020'] },
      affectedZones: ['https://api.weather.gov/zones/forecast/NVZ020'],
    }),
  ],
};

function fixtureFetch({ zoneFails = false } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    const href = String(url);
    calls.push(href);
    const area = new URL(href).searchParams.get('area');
    if (area)
      return new Response(
        JSON.stringify({ type: 'FeatureCollection', features: FEATURES[area] }),
        { headers: { 'content-type': 'application/geo+json' } },
      );
    if (href.endsWith('/CAZ006'))
      return new Response(
        JSON.stringify({
          type: 'Feature',
          geometry: square(-122.45, 37.7, 0.2),
        }),
      );
    if (href.endsWith('/CAZ505'))
      return new Response(
        JSON.stringify({
          type: 'Feature',
          geometry: square(-123.1, 38.3, 0.2),
        }),
      );
    if (zoneFails) return new Response('down', { status: 503 });
    return new Response(JSON.stringify({ type: 'Feature', geometry: null }));
  };
  return { fetchImpl, calls };
}

test('event names map to alert kinds', () => {
  assert.equal(nwsAlertKind('Red Flag Warning'), 'fire');
  assert.equal(nwsAlertKind('Air Quality Alert'), 'air');
  assert.equal(nwsAlertKind('Dense Smoke Advisory'), 'air');
  assert.equal(nwsAlertKind('Evacuation Immediate'), 'emergency');
  assert.equal(nwsAlertKind('Tsunami Warning'), 'emergency');
  assert.equal(nwsAlertKind('Wind Advisory'), 'weather');
});

test('links open the NWS hazard page, the office page or the record', () => {
  assert.equal(
    nwsAlertLink({ geocode: { SAME: ['006075'], UGC: ['CAZ006'] } }),
    'https://forecast.weather.gov/showsigwx.php?warnzone=CAZ006&warncounty=CAC075',
  );
  assert.equal(
    nwsAlertLink({
      geocode: { SAME: ['006037'], UGC: ['CAC037'] },
      parameters: { AWIPSidentifier: ['FFWLOX'] },
    }),
    'https://www.weather.gov/lox/',
  );
  assert.equal(
    nwsAlertLink({ '@id': 'https://api.weather.gov/alerts/x', geocode: {} }),
    'https://api.weather.gov/alerts/x',
  );
});

test('drafts drop tests, exercises, cancellations, expired and out-of-region alerts', () => {
  const drafts = FEATURES.CA.map((entry) => draftNwsAlert(entry, { now: NOW }));
  const ids = drafts.filter(Boolean).map((draft) => draft.alert.id);
  assert.deepEqual(ids, [
    'nws:urn:la-flash-flood',
    'nws:urn:sf-coastal',
    'nws:urn:ventura-only',
    'nws:urn:sonoma-only',
  ]);
  assert.deepEqual(drafts[1].zoneUrls, [
    'https://api.weather.gov/zones/forecast/CAZ006',
  ]);
  assert.deepEqual(drafts[3].alert.regions, ['sonoma-county']);
  assert.equal(draftNwsAlert(null), null);
  assert.equal(draftNwsAlert({ properties: { id: 'x' } }), null);
});

test('an area keeps an alert only in the candidate regions it touches', () => {
  assert.deepEqual(
    regionsTouchedBy(square(-119.35, 34.25), ['los-angeles']),
    [],
  );
  assert.deepEqual(regionsTouchedBy(square(-118.3, 34.0), ['los-angeles']), [
    'los-angeles',
  ]);
  assert.deepEqual(regionsTouchedBy(null, ['las-vegas']), ['las-vegas']);
});

test('the feed resolves zone shapes, falls back to county centres and keeps regions honest', async () => {
  const { fetchImpl, calls } = fixtureFetch({ zoneFails: true });
  const source = createNwsFeedSource({ fetchImpl, now: () => NOW });
  const { alerts, fetchedAt } = await source.load();
  assert.equal(fetchedAt, NOW);
  const byId = Object.fromEntries(alerts.map((alert) => [alert.id, alert]));
  assert.deepEqual(Object.keys(byId).sort(), [
    'nws:urn:clark-flood',
    'nws:urn:la-flash-flood',
    'nws:urn:sf-coastal',
    'nws:urn:sonoma-only',
  ]);
  const la = byId['nws:urn:la-flash-flood'];
  assert.equal(la.severity, 'severe');
  assert.equal(la.kind, 'weather');
  assert.equal(la.areaSource, 'feed');
  assert.deepEqual(la.regions, ['los-angeles']);
  assert.equal(la.url, 'https://www.weather.gov/lox/');
  assert.match(la.body, /Fixture headline — Fixture description\./);
  assert.equal(la.instruction, 'Fixture instruction.');
  const sf = byId['nws:urn:sf-coastal'];
  assert.equal(sf.areaSource, 'zones');
  assert.equal(sf.area.type, 'Polygon');
  assert.deepEqual(sf.regions, ['sf-bay-area']);
  assert.equal(sf.severity, 'minor');
  const sonoma = byId['nws:urn:sonoma-only'];
  assert.deepEqual(sonoma.regions, ['sonoma-county']);
  const clark = byId['nws:urn:clark-flood'];
  assert.equal(clark.areaSource, 'centroid', 'the failed zone falls back');
  assert.deepEqual(clark.area, {
    type: 'Point',
    coordinates: [-115.01, 36.21],
  });
  assert.deepEqual(clark.regions, ['las-vegas']);
  assert.ok(
    calls.every((url) => url.startsWith('https://api.weather.gov/')),
    'only api.weather.gov is asked',
  );
  assert.equal(
    calls.filter((url) => url.includes('/alerts/active')).length,
    2,
    'one request per state',
  );
});

test('zone shapes are cached and bounded per refresh', async () => {
  let requests = 0;
  const cache = createNwsZoneCache({
    fetchImpl: async () => {
      requests += 1;
      return new Response(JSON.stringify({ geometry: square(-122.4, 37.7) }));
    },
    maxPerRefresh: 2,
  });
  const urls = ['CAZ001', 'CAZ002', 'CAZ003'].map(
    (zone) => `https://api.weather.gov/zones/forecast/${zone}`,
  );
  cache.beginRefresh();
  assert.equal((await cache.resolve(urls)).length, 2);
  assert.equal(requests, 2);
  cache.beginRefresh();
  assert.equal((await cache.resolve(urls)).length, 3, 'cached plus one more');
  assert.equal(requests, 3);
  assert.deepEqual(
    await cache.resolve(['https://example.invalid/zones/forecast/CAZ004']),
    [],
    'only api.weather.gov zone addresses are requested',
  );
  assert.equal(requests, 3);
  assert.equal(cache.describe().zones, 3);
});

test('a malformed alerts payload fails the load with a code', async () => {
  const source = createNwsFeedSource({
    fetchImpl: async () => new Response(JSON.stringify({ nope: true })),
  });
  await assert.rejects(
    source.load(),
    (error) => error.code === 'invalid_payload',
  );
});
