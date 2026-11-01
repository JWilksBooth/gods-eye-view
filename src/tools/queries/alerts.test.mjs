import assert from 'node:assert/strict';
import test from 'node:test';
import { composeCatalog, coreTools, toolsForSurface } from '../index.js';
import { createAlert } from '../../layers/alerts/model.js';
import { alertInArea, normalizeAirportCode } from './alerts.js';

const NOW = Date.parse('2026-11-01T17:00:00Z');

const alert = (id, fields) =>
  createAlert(
    {
      id,
      source: id.split(':')[0],
      agency: 'Fixture Agency',
      headline: `Headline ${id}`,
      issued: NOW - 60_000,
      ...fields,
    },
    { fetchedAt: NOW },
  );

const ALERTS = [
  alert('nws:bay', {
    kind: 'weather',
    severity: 'minor',
    regions: ['sf-bay-area'],
    area: {
      type: 'Polygon',
      coordinates: [
        [
          [-122.5, 37.7],
          [-122.3, 37.7],
          [-122.3, 37.9],
          [-122.5, 37.9],
          [-122.5, 37.7],
        ],
      ],
    },
    url: 'https://forecast.weather.gov/showsigwx.php?warnzone=CAZ006&warncounty=CAC075',
  }),
  alert('caltrans:7:C1:1', {
    kind: 'road',
    severity: 'moderate',
    regions: ['los-angeles'],
    area: { type: 'Point', coordinates: [-118.25, 34.05] },
    body: 'x'.repeat(600),
  }),
  alert('nws:vegas', {
    kind: 'weather',
    severity: 'severe',
    regions: ['las-vegas'],
    area: { type: 'Point', coordinates: [-115.01, 36.21] },
    areaSource: 'centroid',
  }),
  alert('bart:1', {
    kind: 'transit',
    severity: 'severe',
    regions: ['sf-bay-area'],
  }),
];

function service({ alerts = ALERTS, sources, airports } = {}) {
  const requests = [];
  return {
    requests,
    alerts: {
      getSnapshot: async (options) => {
        requests.push(options);
        return {
          alerts: alerts.filter(
            (entry) =>
              !options.region || entry.regions.includes(options.region),
          ),
          sources: sources ?? [
            {
              id: 'nws',
              label: 'NWS alerts',
              status: 'ok',
              count: 2,
              refreshMs: 120_000,
              fetchedAt: '2026-11-01T16:59:00.000Z',
            },
            {
              id: 'caltrans',
              label: 'Caltrans lane closures',
              status: 'ok',
              count: 1,
              refreshMs: 600_000,
            },
            {
              id: 'lafd',
              label: 'LAFD alerts',
              status: 'unavailable',
              count: 0,
              error: 'http_404',
            },
            {
              id: 'airnow',
              label: 'AirNow air quality',
              status: 'key-required',
              envVar: 'AIRNOW_API_KEY',
              count: 0,
            },
          ],
          regions: [],
          region: options.region ?? null,
          fetchedAt: '2026-11-01T17:00:00.000Z',
          stale: false,
        };
      },
      getAirports: async () =>
        airports ?? {
          status: 'ok',
          stale: false,
          fetchedAt: '2026-11-01T17:00:00.000Z',
          updatedAt: '2026-11-01T16:59:00.000Z',
          source: 'FAA National Airspace System Status',
          home: 'https://nasstatus.faa.gov/',
          airports: [
            {
              code: 'SFO',
              name: 'San Francisco International',
              lat: 37.6213,
              lon: -122.379,
              regions: ['sf-bay-area'],
              status: 'ground_delay',
            },
            {
              code: 'OAK',
              name: 'Oakland International',
              lat: 37.7126,
              lon: -122.2197,
              regions: ['sf-bay-area'],
              status: 'normal',
            },
            {
              code: 'LAS',
              name: 'Harry Reid International',
              lat: 36.084,
              lon: -115.1537,
              regions: ['las-vegas'],
              status: 'restriction',
            },
          ],
          events: [
            {
              airport: 'SFO',
              status: 'ground_delay',
              reason: 'low ceilings',
              avgDelay: '1 hour',
            },
            {
              airport: 'LAS',
              status: 'restriction',
              reason: 'AD AP CLSD TO NON SKED TRANSIENT GA ACFT',
            },
            {
              airport: 'JFK',
              status: 'ground_stop',
              reason: 'thunderstorms',
              endTime: '5:00 pm EST',
            },
          ],
        },
    },
  };
}

test('both tools are offered on MCP and voice', () => {
  for (const surface of ['mcp', 'voice']) {
    const names = toolsForSurface(coreTools, surface).map((tool) => tool.name);
    assert.ok(names.includes('get_alerts'), surface);
    assert.ok(names.includes('get_airport_status'), surface);
  }
});

test('get_alerts lists every region worst first with feed states', async () => {
  const fixture = service();
  const catalog = composeCatalog({
    tools: coreTools,
    services: { alerts: fixture.alerts },
  });
  const all = await catalog.call('get_alerts', {});
  assert.equal(
    all.summary,
    '4 alerts across Los Angeles, Sonoma County, San Francisco Bay Area, Las Vegas (2 severe, 1 moderate); most by kind: weather (2), road (1), transit (1); no answer from LAFD alerts; AirNow air quality needs a key.',
  );
  // Worst first; equal severity and time fall back to the id.
  assert.deepEqual(
    all.data.rows.map((row) => row.id),
    ['bart:1', 'nws:vegas', 'caltrans:7:C1:1', 'nws:bay'],
  );
  const road = all.data.rows[2];
  assert.equal(road.body.length, 400);
  assert.deepEqual(road.regions, ['los-angeles']);
  assert.equal(road.lat, 34.05);
  assert.equal(all.data.rows[1].placed, 'centroid');
  assert.equal(all.data.rows[0].lat, null, 'a bulletin has no position');
  const airnow = all.data.sources.find((entry) => entry.id === 'airnow');
  assert.equal(airnow.key, 'AIRNOW_API_KEY');
  assert.equal(all.data.sources[0].refresh_seconds, 120);
  assert.equal(all.data.by_severity.severe, 2);
  assert.ok(all.data.view.layers.includes('alerts'));
});

test('get_alerts narrows by region, area, kind and severity', async () => {
  const fixture = service();
  const catalog = composeCatalog({
    tools: coreTools,
    services: { alerts: fixture.alerts },
  });
  const bay = await catalog.call('get_alerts', {
    region: 'sf-bay-area',
    severity: 'severe',
  });
  assert.equal(fixture.requests.at(-1).region, 'sf-bay-area');
  assert.equal(fixture.requests.at(-1).minSeverity, 'severe');
  assert.deepEqual(
    bay.data.rows.map((row) => row.id),
    ['bart:1'],
  );
  assert.match(bay.summary, /^1 alert in San Francisco Bay Area \(1 severe\)/);
  const boxed = await catalog.call('get_alerts', {
    area: { bbox: [-122.45, 37.75, -122.35, 37.85] },
    kind: 'weather',
  });
  assert.deepEqual(
    boxed.data.rows.map((row) => row.id),
    ['nws:bay'],
  );
  assert.deepEqual(fixture.requests.at(-1).kinds, ['weather']);
  const roads = await catalog.call('get_alerts', { kind: 'road', limit: 1 });
  assert.equal(roads.data.returned, 1);
  assert.equal(roads.data.truncated, false);
  await assert.rejects(catalog.call('get_alerts', { region: 'atlantis' }));
});

test('an alert is in an area by its point, its shape or its region', () => {
  const area = {
    label: 'box',
    west: -122.45,
    south: 37.75,
    east: -122.35,
    north: 37.85,
  };
  const [bayArea, closure, , bulletin] = ALERTS;
  assert.equal(alertInArea(bayArea, area), true);
  assert.equal(alertInArea(closure, area), false);
  assert.equal(alertInArea(bulletin, area), true, 'the region box overlaps');
  assert.equal(
    alertInArea(bulletin, {
      label: 'far',
      west: 0,
      south: 0,
      east: 1,
      north: 1,
    }),
    false,
  );
});

test('get_airport_status answers by code, area or region', async () => {
  const fixture = service();
  const catalog = composeCatalog({
    tools: coreTools,
    services: { alerts: fixture.alerts },
  });
  const byCode = await catalog.call('get_airport_status', {
    airports: ['ksfo', 'JFK', 'BOS'],
  });
  assert.equal(
    byCode.summary,
    'SFO ground delay program; JFK ground stop; 1 other airport normal.',
  );
  const [sfo, jfk, bos] = byCode.data.airports;
  assert.equal(sfo.status, 'ground_delay');
  assert.equal(sfo.events[0].average_delay, '1 hour');
  assert.equal(jfk.lat, null);
  assert.equal(jfk.events[0].until, '5:00 pm EST');
  assert.equal(bos.status, 'normal');
  assert.equal(byCode.data.updated_at, '2026-11-01T16:59:00.000Z');
  const region = await catalog.call('get_airport_status', {
    region: 'sf-bay-area',
  });
  assert.deepEqual(
    region.data.airports.map((airport) => airport.code),
    ['SFO', 'OAK'],
  );
  assert.ok(region.data.view.layers.includes('alerts'));
  const area = await catalog.call('get_airport_status', {
    area: { lat: 36.1, lon: -115.15, radius_km: 30 },
  });
  assert.equal(
    area.summary,
    'LAS airport restriction; 0 other airports normal.',
  );
  const all = await catalog.call('get_airport_status', {});
  assert.equal(all.data.airports.length, 3);
  const one = await catalog.call('get_airport_status', { airports: ['OAK'] });
  assert.equal(
    one.summary,
    '1 airport (OAK): no closures, stops or delays reported by the FAA.',
  );
  assert.equal(one.data.view.camera.lat, 37.7126);
  assert.equal(normalizeAirportCode(' klax '), 'LAX');
  assert.equal(normalizeAirportCode('PHNL'), 'PHNL');
});

test('get_airport_status says when the FAA feed is unavailable or stale', async () => {
  const down = service({
    airports: { status: 'unavailable', airports: [], events: [] },
  });
  const catalog = composeCatalog({
    tools: coreTools,
    services: { alerts: down.alerts },
  });
  await assert.rejects(
    catalog.call('get_airport_status', {}),
    (error) => error.code === 'unavailable',
  );
  const stale = service({
    airports: {
      status: 'stale',
      stale: true,
      airports: [
        { code: 'SFO', lat: 37.6, lon: -122.4, regions: ['sf-bay-area'] },
      ],
      events: [],
    },
  });
  const staleCatalog = composeCatalog({
    tools: coreTools,
    services: { alerts: stale.alerts },
  });
  const answer = await staleCatalog.call('get_airport_status', {
    airports: ['SFO'],
  });
  assert.match(answer.summary, /\(FAA status may be stale\)\.$/);
  assert.equal(answer.data.stale, true);
});
