import assert from 'node:assert/strict';
import test from 'node:test';
import { composeCatalog, coreTools, toolsForSurface } from '../index.js';

const row = (id, extra = {}) => ({
  id: `registry:${id}`,
  source: 'registry',
  sourceLabel: 'Curated live cameras',
  title: 'Bellagio Conservatory',
  lat: 36.1129,
  lon: -115.1765,
  region: 'las-vegas',
  kind: 'youtube',
  embed: { type: 'youtube', videoId: 'KJuGU7v5oYw' },
  pageUrl: 'https://www.youtube.com/watch?v=KJuGU7v5oYw',
  poster: 'https://i.ytimg.com/vi/KJuGU7v5oYw/hqdefault.jpg',
  owner: 'EarthCam',
  terms: 'Public YouTube live stream',
  placement: 'exact',
  verifiedAt: '2026-10-31',
  time: null,
  description: null,
  tags: ['strip'],
  ...extra,
});

function streams(rows, sources) {
  const requests = [];
  return {
    requests,
    service: {
      getSnapshot: async () => rows,
      getSnapshotDetail: async (options) => {
        requests.push(options);
        return {
          rows: rows.filter(
            (entry) =>
              (!options.region || entry.region === options.region) &&
              (!options.kind || entry.kind === options.kind),
          ),
          sources: sources ?? [
            {
              id: 'registry',
              label: 'Curated live cameras',
              ok: true,
              count: rows.length,
              refreshMs: 600_000,
              fetchedAt: Date.UTC(2026, 10, 1, 12),
            },
            {
              id: 'youtube',
              label: 'YouTube live discovery',
              ok: false,
              keyRequired: true,
              error: 'no_key',
              count: 0,
            },
          ],
          stale: false,
          fetchedAt: Date.UTC(2026, 10, 1, 12),
        };
      },
    },
  };
}

test('find_live_streams lists streams with a kind breakdown and names keyless sources', async () => {
  const fixture = streams([
    row('lv-bellagio'),
    row('son-caltrans', {
      id: 'registry:son-caltrans',
      title: 'US-101 at College Avenue',
      kind: 'hls',
      embed: {
        type: 'hls',
        url: 'https://wzmedia.dot.ca.gov/D4/S101_at_College_Av.stream/playlist.m3u8',
      },
      pageUrl: 'https://cwwp2.dot.ca.gov/vm/iframemap.htm',
      poster: null,
      owner: 'Caltrans District 4',
      region: 'sonoma-county',
      lat: 38.445377,
      lon: -122.723909,
    }),
    {
      ...row('scanner', {
        id: 'scanner:broadcastify-clark-county',
        source: 'scanner',
        sourceLabel: 'Scanner directories',
        title: 'Clark County scanner feeds',
        kind: 'link',
        embed: {
          type: 'link',
          url: 'https://www.broadcastify.com/listen/ctid/1745',
        },
        pageUrl: 'https://www.broadcastify.com/listen/ctid/1745',
        poster: null,
        owner: 'Broadcastify',
        placement: 'approximate',
        lat: 36.1699,
        lon: -115.1398,
      }),
    },
  ]);
  const catalog = composeCatalog({
    tools: coreTools,
    services: { streams: fixture.service },
  });
  const all = await catalog.call('find_live_streams', {});
  assert.equal(
    all.summary,
    '3 live streams across Los Angeles, Sonoma County, San Francisco Bay Area, Las Vegas; most by kind: hls (1), link (1), youtube (1) (YouTube live discovery need a key).',
  );
  assert.deepEqual(
    all.data.rows.map((entry) => entry.id),
    [
      'registry:lv-bellagio',
      'registry:son-caltrans',
      'scanner:broadcastify-clark-county',
    ],
  );
  assert.deepEqual(all.data.rows[0], {
    id: 'registry:lv-bellagio',
    title: 'Bellagio Conservatory',
    kind: 'youtube',
    source: 'Curated live cameras',
    owner: 'EarthCam',
    region: 'las-vegas',
    lat: 36.1129,
    lon: -115.1765,
    placement: 'exact',
    page_url: 'https://www.youtube.com/watch?v=KJuGU7v5oYw',
    embed: { type: 'youtube', video_id: 'KJuGU7v5oYw' },
    poster: 'https://i.ytimg.com/vi/KJuGU7v5oYw/hqdefault.jpg',
    verified_at: '2026-10-31',
    updated_at: null,
    description: null,
    terms: 'Public YouTube live stream',
    tags: ['strip'],
  });
  assert.deepEqual(all.data.rows[1].embed, {
    type: 'hls',
    url: 'https://wzmedia.dot.ca.gov/D4/S101_at_College_Av.stream/playlist.m3u8',
  });
  assert.equal(all.data.sources[1].key_required, true);
  assert.equal(all.data.sources[0].refresh_seconds, 600);
  assert.deepEqual(all.data.view.layers, ['streams']);

  const vegas = await catalog.call('find_live_streams', {
    region: 'las-vegas',
    kind: 'youtube',
    limit: 1,
  });
  assert.deepEqual(fixture.requests.at(-1), {
    region: 'las-vegas',
    kind: 'youtube',
    signal: fixture.requests.at(-1).signal,
  });
  assert.equal(
    vegas.summary,
    '1 live stream in Las Vegas; most by kind: youtube (1) (YouTube live discovery need a key).',
  );
  assert.equal(vegas.data.returned, 1);
  assert.equal(vegas.data.truncated, false);

  const boxed = await catalog.call('find_live_streams', {
    area: { bbox: [-123.55, 38.1, -122.35, 38.86] },
    source: 'registry',
  });
  assert.deepEqual(
    boxed.data.rows.map((entry) => entry.id),
    ['registry:son-caltrans'],
  );
});

test('find_live_streams reports failing sources and stale data', async () => {
  const fixture = streams(
    [],
    [
      {
        id: 'registry',
        label: 'Curated live cameras',
        ok: false,
        error: 'EACCES',
        count: 0,
      },
      {
        id: 'scanner',
        label: 'Scanner directories',
        ok: false,
        error: 'disabled',
        count: 0,
      },
    ],
  );
  const catalog = composeCatalog({
    tools: coreTools,
    services: { streams: fixture.service },
  });
  const result = await catalog.call('find_live_streams', {
    region: 'sonoma-county',
  });
  assert.equal(
    result.summary,
    '0 live streams in Sonoma County (no live data from Curated live cameras).',
  );
  assert.equal(result.data.sources[0].error, 'EACCES');
});

test('find_live_streams is offered on MCP and voice', () => {
  for (const surface of ['mcp', 'voice']) {
    const names = toolsForSurface(coreTools, surface).map((tool) => tool.name);
    assert.ok(names.includes('find_live_streams'), surface);
  }
});
