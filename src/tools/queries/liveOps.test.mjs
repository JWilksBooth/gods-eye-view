import assert from 'node:assert/strict';
import test from 'node:test';
import { composeCatalog, coreTools, toolsForSurface } from '../index.js';

const row = (id, extra = {}) => ({
  id: `chp:${id}`,
  source: 'chp',
  sourceLabel: 'CHP CAD',
  agency: 'CHP Los Angeles',
  type: 'traffic',
  typeDetail: 'Trfc Collision-No Inj',
  lat: 34.05,
  lon: -118.25,
  location: 'I-10 W / Alameda St',
  area: 'Central LA',
  time: Date.UTC(2026, 10, 1, 12),
  description: null,
  region: 'los-angeles',
  url: 'https://cad.chp.ca.gov/',
  ...extra,
});

function incidents(rows, sources = [{ id: 'chp', label: 'CHP CAD', ok: true, count: rows.length, refreshMs: 60_000, fetchedAt: Date.UTC(2026, 10, 1, 12, 1) }]) {
  const requests = [];
  return {
    requests,
    service: {
      getSnapshot: async () => rows,
      getSnapshotDetail: async (options) => {
        requests.push(options);
        return {
          rows: rows.filter((entry) => !options.region || entry.region === options.region),
          sources,
          stale: false,
          fetchedAt: Date.UTC(2026, 10, 1, 12, 1),
        };
      },
    },
  };
}

test('get_incidents lists a region newest first with its type breakdown and source states', async () => {
  const fixture = incidents([
    row('1'),
    row('2', { type: 'fire', time: Date.UTC(2026, 10, 1, 13), region: 'sonoma-county', lat: 38.5, lon: -122.7 }),
    row('3', { type: 'traffic', time: Date.UTC(2026, 10, 1, 11) }),
  ]);
  const catalog = composeCatalog({
    tools: coreTools,
    services: { incidents: fixture.service },
  });
  const all = await catalog.call('get_incidents', {});
  assert.equal(
    all.summary,
    '3 live incidents across Los Angeles, Sonoma County, San Francisco Bay Area, Las Vegas; most by type: traffic (2), fire (1).',
  );
  assert.deepEqual(
    all.data.rows.map((entry) => entry.id),
    ['chp:2', 'chp:1', 'chp:3'],
  );
  assert.deepEqual(all.data.rows[1], {
    id: 'chp:1',
    type: 'traffic',
    type_detail: 'Trfc Collision-No Inj',
    agency: 'CHP Los Angeles',
    source: 'CHP CAD',
    location: 'I-10 W / Alameda St',
    area: 'Central LA',
    region: 'los-angeles',
    lat: 34.05,
    lon: -118.25,
    time: '2026-11-01T12:00:00.000Z',
    description: null,
    url: 'https://cad.chp.ca.gov/',
  });
  assert.equal(all.data.sources[0].refresh_seconds, 60);
  const la = await catalog.call('get_incidents', {
    region: 'los-angeles',
    type: 'traffic',
    limit: 1,
  });
  assert.equal(fixture.requests.at(-1).region, 'los-angeles');
  assert.equal(la.summary, '2 live incidents in Los Angeles; most by type: traffic (2).');
  assert.equal(la.data.returned, 1);
  assert.equal(la.data.truncated, true);
  assert.equal(la.data.view.layers.includes('incidents'), true);
  const boxed = await catalog.call('get_incidents', {
    area: { bbox: [-123, 38, -122, 39] },
  });
  assert.deepEqual(
    boxed.data.rows.map((entry) => entry.id),
    ['chp:2'],
  );
});

test('get_incidents names feeds that are not answering', async () => {
  const fixture = incidents([], [
    { id: 'chp', label: 'CHP CAD', ok: false, error: 'HTTP 503', count: 0 },
    { id: 'lafd-alerts', label: 'LAFD alerts', ok: false, error: 'disabled', count: 0 },
  ]);
  const catalog = composeCatalog({
    tools: coreTools,
    services: { incidents: fixture.service },
  });
  const result = await catalog.call('get_incidents', { region: 'las-vegas' });
  assert.equal(
    result.summary,
    '0 live incidents in Las Vegas (no live data from CHP CAD).',
  );
  assert.equal(result.data.sources[0].error, 'HTTP 503');
});

test('live_ops_region combines cameras, incidents and headlines for one region', async () => {
  const fixture = incidents([row('1')]);
  const catalog = composeCatalog({
    tools: coreTools,
    services: {
      incidents: fixture.service,
      cctv: {
        getCatalog: async () => ({
          sources: [
            { id: 'ca-d7-tv1', name: 'I-10 at Alameda', city: 'Los Angeles', provider: 'Caltrans', lat: 34.04, lon: -118.24, headingDeg: 90, feedType: 'image' },
            { id: 'nv-1', name: 'I-15 at Tropicana', city: 'Las Vegas', provider: 'Nevada 511', lat: 36.1, lon: -115.17, headingDeg: 0, feedType: 'image' },
          ],
        }),
      },
      liveOps: {
        getHeadlines: async (regionId) => ({
          status: 'ready',
          region: regionId,
          source: 'Google News RSS',
          query: 'Los Angeles',
          articles: [
            { title: 'Brush fire closes the 405', url: 'https://example.com/a', domain: 'example.com', publishedAt: '2026-11-01T10:00:00.000Z' },
          ],
        }),
      },
      app: { baseUrl: 'http://localhost:4173' },
    },
  });
  const result = await catalog.call('live_ops_region', { region: 'los-angeles', limit: 5 });
  assert.equal(
    result.summary,
    'Los Angeles LIVE OPS: 1 public camera in the requested box. 1 live incident in Los Angeles; most by type: traffic (1). 1 headline for Los Angeles.',
  );
  assert.equal(result.data.name, 'Los Angeles');
  assert.deepEqual(result.data.view.layers, ['cctv', 'incidents', 'traffic', 'transit']);
  assert.match(result.data.view.url, /^http:\/\/localhost:4173\//);
  assert.equal(result.data.cameras.rows[0].id, 'ca-d7-tv1');
  assert.equal(result.data.incidents.rows[0].id, 'chp:1');
  assert.equal(result.data.headlines.articles[0].title, 'Brush fire closes the 405');
  assert.equal(fixture.requests.at(-1).region, 'los-angeles');
  await assert.rejects(
    catalog.call('live_ops_region', { region: 'mars' }),
    /must be one of/,
  );
});

test('a region call survives a failing section and a missing headline source', async () => {
  const catalog = composeCatalog({
    tools: coreTools,
    services: {
      incidents: {
        getSnapshot: async () => [],
        getSnapshotDetail: async () => {
          throw new Error('boom');
        },
      },
      liveOps: {
        getHeadlines: async () => {
          throw new Error('offline');
        },
      },
    },
  });
  const result = await catalog.call('live_ops_region', { region: 'sonoma-county' });
  assert.equal(result.data.incidents.unavailable, true);
  assert.equal(result.data.headlines.unavailable, true);
  assert.equal(result.data.cameras, undefined);
  assert.equal(result.summary, 'Sonoma County LIVE OPS: no section answered.');
});

test('both LIVE OPS tools are offered on MCP and voice', () => {
  for (const surface of ['mcp', 'voice']) {
    const names = toolsForSurface(coreTools, surface).map((tool) => tool.name);
    assert.ok(names.includes('get_incidents'), surface);
    assert.ok(names.includes('live_ops_region'), surface);
  }
});
