import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import {
  LIVE_OPS_HEADLINES_CACHE_MS,
  liveOpsHeadlinesProxy,
} from './live-ops.js';
import { liveOpsRegion } from '../../../src/data/liveOpsRegions.js';
import { createLiveOpsHeadlineSource } from '../../../src/sources/liveOpsHeadlines.js';

function request(url) {
  const req = new EventEmitter();
  Object.assign(req, {
    method: 'GET',
    url,
    headers: { host: 'localhost:4173' },
    socket: { remoteAddress: '127.0.0.1' },
  });
  const res = new EventEmitter();
  const out = { status: null, headers: null, body: '' };
  Object.assign(res, {
    destroyed: false,
    writeHead(status, headers) {
      out.status = status;
      out.headers = headers;
    },
    end(body) {
      out.body = body || '';
    },
  });
  return { req, res, out };
}

const article = {
  title: 'Brush fire closes the 405',
  url: 'https://example.com/story',
  domain: 'example.com',
  publishedAt: '2026-11-01T10:00:00.000Z',
  sourceCountry: null,
};

test('headlines are asked with the region query, cached, and served stale on failure', async () => {
  let clock = 1_000_000;
  let fail = false;
  const asked = [];
  const plugin = liveOpsHeadlinesProxy({
    now: () => clock,
    headlines: async (region) => {
      asked.push(region.news);
      if (fail) return { status: 'unavailable', query: null, articles: [], source: null };
      return {
        status: 'ready',
        query: region.news,
        articles: [article],
        source: 'Google News RSS',
      };
    },
  });
  let handler;
  plugin.configureServer({
    middlewares: { use: (path, fn) => ((handler = fn), path) },
  });
  let call = request('/?region=sonoma-county');
  await handler(call.req, call.res);
  assert.equal(call.out.status, 200);
  assert.equal(call.out.headers['X-Live-Ops-Headlines'], 'MISS');
  const payload = JSON.parse(call.out.body);
  assert.equal(payload.name, 'Sonoma County');
  assert.equal(payload.query, 'Sonoma County');
  assert.equal(payload.articles[0].title, article.title);
  assert.deepEqual(asked, ['Sonoma County']);
  call = request('/?region=sonoma-county');
  await handler(call.req, call.res);
  assert.equal(call.out.headers['X-Live-Ops-Headlines'], 'HIT');
  assert.equal(JSON.parse(call.out.body).status, 'cached');
  clock += LIVE_OPS_HEADLINES_CACHE_MS + 1;
  fail = true;
  call = request('/?region=sonoma-county');
  await handler(call.req, call.res);
  assert.equal(call.out.headers['X-Live-Ops-Headlines'], 'STALE');
  assert.equal(JSON.parse(call.out.body).status, 'stale');
  call = request('/?region=mars');
  await handler(call.req, call.res);
  assert.equal(call.out.status, 400);
  assert.equal(JSON.parse(call.out.body).regions.length, 4);
  fail = false;
  assert.equal((await plugin.headlines('las-vegas')).name, 'Las Vegas');
});

test('the browser source re-validates every article it is handed', async () => {
  const source = createLiveOpsHeadlineSource({
    fetchImpl: async (url) => {
      assert.equal(url, '/api/live-ops/headlines?region=los-angeles');
      return Response.json({
        status: 'ready',
        region: 'los-angeles',
        name: liveOpsRegion('los-angeles').name,
        source: 'Google News RSS',
        articles: [
          article,
          { title: 'bad link', url: 'javascript:alert(1)' },
          { title: '', url: 'https://example.com/empty' },
        ],
      });
    },
  });
  const result = await source.getHeadlines('los-angeles');
  assert.equal(result.name, 'Los Angeles');
  assert.deepEqual(
    result.articles.map((entry) => entry.title),
    ['Brush fire closes the 405'],
  );
  assert.equal(result.articles[0].publishedAt, '2026-11-01T10:00:00.000Z');
});
