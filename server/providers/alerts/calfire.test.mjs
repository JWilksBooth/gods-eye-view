import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CALFIRE_INCIDENT_URLS,
  calFireRows,
  calFireSeverity,
  createCalFireFeedSource,
  normalizeCalFireIncident,
} from './calfire.js';

const FETCHED = Date.parse('2026-11-01T17:00:00Z');

const GEOJSON_LIST = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-118.55, 34.2] },
      properties: {
        Name: 'Fixture Fire',
        Updated: '2026-11-01T16:00:00Z',
        Started: '2026-11-01T09:00:00Z',
        AdminUnit: 'Los Angeles County Fire',
        County: 'Los Angeles',
        Location: 'Fixture Canyon Road',
        AcresBurned: 1450,
        PercentContained: 10,
        ControlStatement: 'Evacuation warnings in place.',
        Type: 'Wildfire',
        UniqueId: 'fixture-1',
        Url: '/incidents/2026/11/1/fixture-fire/',
        IsActive: true,
      },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-121.5, 40.5] },
      properties: { Name: 'Far Fire', UniqueId: 'far', AcresBurned: 10 },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-122.3, 37.8] },
      properties: {
        Name: 'Out Fire',
        UniqueId: 'out',
        ExtinguishedDate: '2026-10-30T00:00:00Z',
      },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-122.3, 37.8] },
      properties: {
        Name: 'Inactive Fire',
        UniqueId: 'inactive',
        IsActive: false,
      },
    },
  ],
};

test('severity reads size and containment', () => {
  assert.equal(calFireSeverity(60_000, 10), 'extreme');
  assert.equal(calFireSeverity(6000, 80), 'severe');
  assert.equal(calFireSeverity(1200, 10), 'severe');
  assert.equal(calFireSeverity(400, 60), 'moderate');
  assert.equal(calFireSeverity(20, 10), 'moderate');
  assert.equal(calFireSeverity(20, 90), 'minor');
  assert.equal(calFireSeverity(90_000, 100), 'minor');
});

test('GeoJSON and plain lists normalize to fire alerts inside the regions', () => {
  const rows = calFireRows(GEOJSON_LIST);
  const alerts = rows
    .map((row) => normalizeCalFireIncident(row, { fetchedAt: FETCHED }))
    .filter(Boolean);
  assert.equal(alerts.length, 1);
  const [fire] = alerts;
  assert.equal(fire.id, 'calfire:fixture-1');
  assert.equal(fire.kind, 'fire');
  assert.equal(fire.severity, 'severe');
  assert.equal(fire.agency, 'Los Angeles County Fire');
  assert.equal(fire.headline, 'Fixture Fire');
  assert.equal(
    fire.body,
    '1,450 acres · 10% contained · Evacuation warnings in place.',
  );
  assert.deepEqual(fire.regions, ['los-angeles']);
  assert.equal(
    fire.url,
    'https://www.fire.ca.gov/incidents/2026/11/1/fixture-fire/',
  );
  assert.equal(fire.areaDescription, 'Fixture Canyon Road, Los Angeles County');
  const plain = calFireRows([
    {
      name: 'Plain Fire',
      longitude: -115.2,
      latitude: 36.1,
      uniqueId: 'plain',
      type: 'Prescribed Fire',
    },
  ]);
  const [rx] = plain.map((row) => normalizeCalFireIncident(row));
  assert.equal(rx.headline, 'Plain Fire · Prescribed Fire');
  assert.deepEqual(rx.regions, ['las-vegas']);
  assert.equal(rx.url, 'https://www.fire.ca.gov/incidents');
  assert.equal(calFireRows({ nope: 1 }), null);
});

test('the feed falls back to the plain list and remembers what answered', async () => {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(String(url));
    if (String(url) === CALFIRE_INCIDENT_URLS[0])
      return new Response('busy', { status: 503 });
    return new Response(
      JSON.stringify(
        GEOJSON_LIST.features.map((f) => ({
          ...f.properties,
          Longitude: f.geometry.coordinates[0],
          Latitude: f.geometry.coordinates[1],
        })),
      ),
    );
  };
  const source = createCalFireFeedSource({ fetchImpl, now: () => FETCHED });
  const first = await source.load();
  assert.equal(first.alerts.length, 1);
  assert.deepEqual(asked, CALFIRE_INCIDENT_URLS);
  await source.load();
  assert.equal(
    asked.at(-1),
    CALFIRE_INCIDENT_URLS[1],
    'the working address goes first',
  );
  assert.equal(asked.length, 3);
  const broken = createCalFireFeedSource({
    fetchImpl: async () => new Response('<html>', { status: 200 }),
  });
  await assert.rejects(broken.load(), SyntaxError);
});
