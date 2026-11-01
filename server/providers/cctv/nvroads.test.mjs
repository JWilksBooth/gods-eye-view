import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NVROADS_TABLE_PAGE_SIZE,
  loadNvroadsSources,
  nvroadsApiRowToSource,
  nvroadsTableRowToSource,
  parseNvroadsPoint,
} from './nvroads.js';

const TABLE_ROW = {
  id: 2362,
  source: 'NDOT',
  roadway: 'I-15',
  direction: 'NB',
  location: 'I-15 at Tropicana',
  region: 'Las Vegas',
  latLng: {
    geography: {
      coordinateSystemId: 4326,
      wellKnownText: 'POINT (-115.1725 36.1003)',
    },
  },
  images: [
    {
      id: 2362,
      imageUrl: '/map/Cctv/2362',
      videoUrl: 'https://example.invalid/playlist.m3u8',
      disabled: false,
      blocked: false,
      description: 'Northbound',
    },
  ],
};

const API_ROW = {
  Id: 2362,
  Roadway: 'I-15',
  Direction: 'Northbound',
  Latitude: 36.1003,
  Longitude: -115.1725,
  Location: 'I-15 at Tropicana',
  Views: [
    {
      Id: 2362,
      Url: 'https://www.nvroads.com/map/Cctv/2362',
      Status: 'Enabled',
      Description: 'Northbound',
    },
  ],
};

function captureConsole(t) {
  const lines = [];
  const capture = (...args) => lines.push(args.join(' '));
  t.mock.method(console, 'warn', capture);
  t.mock.method(console, 'log', capture);
  return lines;
}

test('WKT points are longitude first', () => {
  assert.deepEqual(parseNvroadsPoint('POINT (-115.17 36.10)'), {
    lon: -115.17,
    lat: 36.1,
  });
  assert.ok(Number.isNaN(parseNvroadsPoint('nope').lat));
});

test('a keyless table row becomes a host-pinned Las Vegas camera', () => {
  const camera = nvroadsTableRowToSource(TABLE_ROW);
  assert.equal(camera.id, 'nv-2362');
  assert.equal(camera.url, 'https://www.nvroads.com/map/Cctv/2362');
  assert.equal(camera.lat, 36.1003);
  assert.equal(camera.lon, -115.1725);
  assert.equal(camera.headingDeg, 0);
  assert.equal(camera.headingConfidence, 'high');
  assert.equal(camera.city, 'Las Vegas');
  assert.equal(camera.sourceKind, 'nvroads-open-data');
  assert.equal(camera.name, 'I-15 at Tropicana - Northbound');
});

test('rows with a foreign image host, a disabled view or an out-of-state point are dropped', () => {
  assert.equal(
    nvroadsTableRowToSource({
      ...TABLE_ROW,
      images: [{ ...TABLE_ROW.images[0], imageUrl: 'https://evil.invalid/x' }],
    }),
    null,
  );
  assert.equal(
    nvroadsTableRowToSource({
      ...TABLE_ROW,
      images: [{ ...TABLE_ROW.images[0], disabled: true }],
    }),
    null,
  );
  assert.equal(
    nvroadsTableRowToSource({
      ...TABLE_ROW,
      latLng: { geography: { wellKnownText: 'POINT (-80 25)' } },
    }),
    null,
  );
});

test('a developer-API row maps the same way and derives the still from the view id', () => {
  const camera = nvroadsApiRowToSource(API_ROW);
  assert.equal(camera.id, 'nv-2362');
  assert.equal(camera.url, 'https://www.nvroads.com/map/Cctv/2362');
  const noUrl = nvroadsApiRowToSource({
    ...API_ROW,
    Views: [{ Id: 99, Status: 'Enabled' }],
  });
  assert.equal(noUrl.url, 'https://www.nvroads.com/map/Cctv/99');
  assert.equal(
    nvroadsApiRowToSource({
      ...API_ROW,
      Views: [{ ...API_ROW.Views[0], Status: 'Disabled' }],
    }),
    null,
  );
});

test('keyless loads page the site table until a short page', async (t) => {
  captureConsole(t);
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const parsed = new URL(String(url));
    requested.push(parsed);
    const start = JSON.parse(parsed.searchParams.get('query')).start;
    const rows =
      start === 0
        ? Array.from({ length: NVROADS_TABLE_PAGE_SIZE }, (_, i) => ({
            ...TABLE_ROW,
            id: 1000 + i,
            images: [{ ...TABLE_ROW.images[0], imageUrl: `/map/Cctv/${1000 + i}` }],
          }))
        : [TABLE_ROW];
    return Response.json({ recordsTotal: 101, recordsFiltered: 101, data: rows });
  });
  const cameras = await loadNvroadsSources({}, {});
  assert.equal(requested.length, 2);
  assert.equal(requested[0].pathname, '/List/GetData/Cameras');
  assert.equal(requested[0].searchParams.get('lang'), 'en-US');
  assert.equal(cameras.length, 101);
});

test('a configured key uses the developer API and falls back to the table when it fails', async (t) => {
  captureConsole(t);
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const parsed = new URL(String(url));
    requested.push(parsed);
    if (parsed.pathname === '/api/v2/get/cameras')
      return parsed.searchParams.get('key') === 'good'
        ? Response.json([API_ROW])
        : new Response('Invalid Key', { status: 400 });
    return Response.json({ recordsTotal: 1, data: [TABLE_ROW] });
  });
  const viaApi = await loadNvroadsSources({}, { NVROADS_API_KEY: 'good' });
  assert.equal(viaApi.length, 1);
  assert.equal(requested.length, 1);
  assert.equal(requested[0].searchParams.get('key'), 'good');
  const viaTable = await loadNvroadsSources({}, { NVROADS_API_KEY: 'bad' });
  assert.equal(viaTable.length, 1);
  assert.equal(requested.at(-1).pathname, '/List/GetData/Cameras');
});

test('an unreachable site yields an empty pack, never a throw', async (t) => {
  const lines = captureConsole(t);
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('ENOTFOUND');
  });
  assert.deepEqual(await loadNvroadsSources({}, {}), []);
  assert.match(lines.join('\n'), /Nevada 511/);
});
