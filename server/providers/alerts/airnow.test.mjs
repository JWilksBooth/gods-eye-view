import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AIRNOW_DATA_URL,
  airNowAlert,
  airNowRegionUrl,
  aqiCategory,
  createAirNowFeedSource,
  normalizeAirNowRows,
} from './airnow.js';
import { upstreamErrorCode } from './http.js';

const NOW = Date.parse('2026-11-01T17:10:00Z');

// AirNow "Observations by Monitor" rows (verbose), one site reporting two
// pollutants over two hours, another one pollutant.
const ROWS = [
  {
    Latitude: 34.0669,
    Longitude: -118.2272,
    UTC: '2026-11-01T15:00',
    Parameter: 'PM2.5',
    AQI: 88,
    Category: 2,
    SiteName: 'Fixture Site A',
    AgencyName: 'Fixture AQMD',
    FullAQSCode: '840060371103',
  },
  {
    Latitude: 34.0669,
    Longitude: -118.2272,
    UTC: '2026-11-01T16:00',
    Parameter: 'PM2.5',
    AQI: 104,
    Category: 3,
    SiteName: 'Fixture Site A',
    AgencyName: 'Fixture AQMD',
    FullAQSCode: '840060371103',
  },
  {
    Latitude: 34.0669,
    Longitude: -118.2272,
    UTC: '2026-11-01T16:00',
    Parameter: 'OZONE',
    AQI: 40,
    Category: 1,
    SiteName: 'Fixture Site A',
    AgencyName: 'Fixture AQMD',
    FullAQSCode: '840060371103',
  },
  {
    Latitude: 33.9,
    Longitude: -118.1,
    UTC: '2026-11-01T16:00',
    Parameter: 'OZONE',
    AQI: 35,
    SiteName: 'Fixture Site B',
    FullAQSCode: '840060370002',
  },
  { Latitude: 'x', Longitude: -118.1, UTC: '2026-11-01T16:00', AQI: 20 },
  { Latitude: 33.9, Longitude: -118.1, UTC: 'not a time', AQI: 20 },
];

test('AQI values map to the EPA categories', () => {
  assert.deepEqual(
    [0, 50, 51, 100, 101, 150, 151, 200, 201, 300, 301].map(aqiCategory),
    [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6],
  );
  assert.equal(aqiCategory(-1), null);
});

test('rows collapse to each site’s newest, worst reading', () => {
  const readings = normalizeAirNowRows(ROWS, 'los-angeles');
  assert.equal(readings.length, 2);
  const [a, b] = readings;
  assert.equal(a.id, 'airnow:840060371103');
  assert.equal(a.aqi, 104);
  assert.equal(a.parameter, 'PM2.5');
  assert.equal(a.category, 3);
  assert.equal(a.categoryName, 'Unhealthy for Sensitive Groups');
  assert.equal(a.observedAt, '2026-11-01T16:00:00.000Z');
  assert.equal(b.category, 1, 'a missing category is derived from the AQI');
  assert.equal(normalizeAirNowRows({ error: 'x' }, 'los-angeles'), null);
});

test('only unhealthy readings become air alerts', () => {
  const [a, b] = normalizeAirNowRows(ROWS, 'los-angeles');
  const alert = airNowAlert(a, { fetchedAt: NOW });
  assert.equal(alert.kind, 'air');
  assert.equal(alert.severity, 'moderate');
  assert.equal(
    alert.headline,
    'AQI 104 · Unhealthy for Sensitive Groups (PM2.5)',
  );
  assert.equal(alert.agency, 'Fixture AQMD');
  assert.deepEqual(alert.regions, ['los-angeles']);
  assert.deepEqual(alert.area, {
    type: 'Point',
    coordinates: [-118.2272, 34.0669],
  });
  assert.equal(airNowAlert(b), null);
  assert.equal(
    airNowAlert({ ...a, category: 5, aqi: 250 }).severity,
    'extreme',
  );
});

test('keyless AirNow is never asked; keyed requests never leak the key', async () => {
  const env = {};
  const asked = [];
  const source = createAirNowFeedSource({
    env,
    now: () => NOW,
    fetchImpl: async (url) => {
      asked.push(String(url));
      if (asked.length === 2)
        return new Response('Invalid API key fixture-key', { status: 401 });
      return new Response(JSON.stringify(ROWS));
    },
  });
  assert.equal(source.keyMissing(), true);
  await assert.rejects(source.load(), (error) => error.code === 'no_key');
  assert.equal(asked.length, 0);
  env.AIRNOW_API_KEY = 'fixture-key';
  assert.equal(source.keyMissing(), false);
  const loaded = await source.load();
  assert.equal(asked.length, 4, 'one request per region box');
  assert.equal(loaded.partial, true, 'one region box failed');
  assert.ok(loaded.readings.length > 0);
  assert.ok(loaded.alerts.every((alert) => alert.kind === 'air'));
  const url = new URL(asked[0]);
  assert.equal(`${url.origin}${url.pathname}`, AIRNOW_DATA_URL);
  assert.equal(url.searchParams.get('API_KEY'), 'fixture-key');
  assert.equal(url.searchParams.get('BBOX'), '-118.95,33.6,-117.65,34.45');
  assert.equal(url.searchParams.get('startDate'), '2026-11-01T15');
  assert.equal(url.searchParams.get('endDate'), '2026-11-01T17');
  const failing = createAirNowFeedSource({
    env,
    fetchImpl: async () =>
      new Response('Invalid API key fixture-key', { status: 401 }),
  });
  await assert.rejects(failing.load(), (error) => {
    assert.equal(upstreamErrorCode(error), 'http_401');
    assert.doesNotMatch(String(error.message), /fixture-key/);
    return true;
  });
  assert.match(
    airNowRegionUrl({ bbox: [-1, -2, 3, 4] }, 'k', NOW),
    /BBOX=-1%2C-2%2C3%2C4/,
  );
});
