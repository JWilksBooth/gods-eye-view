import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NVFAST_CATALOG_URL,
  loadNvfastSources,
  nvfastRowToSource,
  nvfastStreamUrl,
  parseNvfastCatalogPage,
} from './nvfast.js';

/* Rows as the dashboard page embeds them (2026-11-02), with the leading
   space and the & escape the page really carries. */
const PAGE = `<html><script>var obj = eval({"TempTable":[[100," I-15 SB I-515 Interchange (dual)",36.1738413699812,-115.156049643255,"snapshot","https://d1wse1.its.nv.gov:443/vegasxcd04/i15_sb_i515_interchange_dual2_public.stream/playlist.m3u8"],[102,"I-15 NB Symphony",36.17085057,-115.1573358,"snapshot",null],[107,"107 I-15 NB Charleston On",36.16050888,-115.1599386,"snapshot",null],[50742," Green Valley \\u0026 I-215 WB Beltway",36.024799,-115.085297,"snapshot",null],[84002,"Las Vegas Blvd at Welcome Sign [stationary]",36.0811,-115.172699,"snapshot",null]]})</script><p>unrelated [1, 2]</p></html>`;

test('the camera table is cut out of the dashboard page and parsed as JSON', () => {
  const rows = parseNvfastCatalogPage(PAGE);
  assert.equal(rows.length, 5);
  assert.equal(rows[3][1], ' Green Valley & I-215 WB Beltway');
  assert.equal(rows[4][1], 'Las Vegas Blvd at Welcome Sign [stationary]');
  assert.throws(() => parseNvfastCatalogPage('<html>no table</html>'));
  assert.throws(() => parseNvfastCatalogPage('"TempTable":[[1,"x"'));
});

test('a row with an NDOT playlist becomes a live camera with the still as its snapshot', () => {
  const camera = nvfastRowToSource(parseNvfastCatalogPage(PAGE)[0]);
  assert.equal(camera.id, 'nvfast-100');
  assert.equal(camera.name, 'I-15 SB I-515 Interchange (dual)');
  assert.equal(camera.city, 'Las Vegas');
  assert.equal(camera.provider, 'RTC of Southern Nevada FAST');
  assert.equal(camera.feedType, 'hls');
  assert.equal(
    camera.url,
    'https://d1wse1.its.nv.gov/vegasxcd04/i15_sb_i515_interchange_dual2_public.stream/playlist.m3u8',
  );
  assert.equal(camera.snapshotUrl, 'https://bugatti.nvfast.org/Snapshots/100.jpeg');
  assert.equal(camera.headingDeg, 180);
  assert.equal(camera.headingConfidence, 'medium');
  assert.equal(camera.sourceKind, 'nvfast-dashboard');
  assert.equal(camera.groundElevationM, 620);
});

test('stills-only rows, repeated ids in names and the video switch', () => {
  const rows = parseNvfastCatalogPage(PAGE);
  const symphony = nvfastRowToSource(rows[1]);
  assert.equal(symphony.feedType, 'image');
  assert.equal(symphony.url, 'https://bugatti.nvfast.org/Snapshots/102.jpeg');
  assert.equal(symphony.headingDeg, 0);
  const charleston = nvfastRowToSource(rows[2]);
  assert.equal(charleston.name, 'I-15 NB Charleston On');
  const noVideo = nvfastRowToSource(rows[0], { video: false });
  assert.equal(noVideo.feedType, 'image');
  assert.equal(noVideo.url, noVideo.snapshotUrl);
  const sign = nvfastRowToSource(rows[4]);
  assert.equal(sign.headingConfidence, 'low');
});

test('rows with a bad id, no position, or a point outside Clark County are dropped', () => {
  assert.equal(nvfastRowToSource(['abc', 'x', 36.1, -115.1, 'snapshot', null]), null);
  assert.equal(nvfastRowToSource([5, 'x', 'n/a', -115.1, 'snapshot', null]), null);
  assert.equal(nvfastRowToSource([5, 'x', 39.5, -119.8, 'snapshot', null]), null);
  assert.equal(nvfastRowToSource('not a row'), null);
  assert.equal(nvfastRowToSource([5, 'Laughlin', 35.17, -114.57, 'snapshot', null]).city, 'Clark County');
});

test('only NDOT playlists on its own hosts are accepted as streams', () => {
  const good = 'https://d1wse2.its.nv.gov:443/vegasxcd05/i-15_nb_oakey_public.stream/playlist.m3u8';
  assert.equal(
    nvfastStreamUrl(good),
    'https://d1wse2.its.nv.gov/vegasxcd05/i-15_nb_oakey_public.stream/playlist.m3u8',
  );
  for (const bad of [
    null,
    '',
    'http://d1wse1.its.nv.gov/vegasxcd04/x.stream/playlist.m3u8',
    'https://evil.invalid/vegasxcd04/x.stream/playlist.m3u8',
    'https://d1wse1.its.nv.gov:8443/vegasxcd04/x.stream/playlist.m3u8',
    'https://user:pw@d1wse1.its.nv.gov/vegasxcd04/x.stream/playlist.m3u8',
    'https://d1wse1.its.nv.gov/vegasxcd04/x.stream/playlist.m3u8?token=1',
    'https://d1wse1.its.nv.gov/vegasxcd04/x.stream/chunklist.m3u8',
    'https://d1wse1.its.nv.gov/x.stream/playlist.m3u8',
  ])
    assert.equal(nvfastStreamUrl(bad), null, String(bad));
});

test('the loader fetches the page once, dedupes ids, ranks the valley first and caps', async (t) => {
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  t.mock.method(console, 'warn', (...args) => lines.push(args.join(' ')));
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requested.push({ url: String(url), init });
    return new Response(PAGE.replace('[84002,', '[102,"dup",36.1,-115.1,"snapshot",null],[84002,'), {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  });
  const cameras = await loadNvfastSources({}, { CCTV_NVFAST_MAX_SOURCES: '20' });
  assert.equal(requested.length, 1);
  assert.equal(requested[0].url, NVFAST_CATALOG_URL);
  assert.equal(requested[0].init.redirect, 'manual');
  assert.equal(cameras.length, 5);
  assert.ok(cameras.every((camera, i, all) => all.findIndex((c) => c.id === camera.id) === i));
  assert.equal(cameras[0].city, 'Las Vegas');
  // Stills by default: NDOT's public playlists were all offline when sampled.
  assert.ok(cameras.every((camera) => camera.feedType === 'image'));
  assert.ok(lines.some((line) => line.includes('RTC FAST')));
  const live = await loadNvfastSources({}, { CCTV_NVFAST_VIDEO: '1' });
  assert.equal(live.find((camera) => camera.id === 'nvfast-100').feedType, 'hls');
});

test('an upstream failure yields an empty pack, never a throw', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  assert.deepEqual(await loadNvfastSources({}, {}), []);
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('offline');
  });
  assert.deepEqual(await loadNvfastSources({}, {}), []);
});
