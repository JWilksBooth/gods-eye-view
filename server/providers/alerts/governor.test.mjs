import assert from 'node:assert/strict';
import test from 'node:test';
import { createFeedGovernor } from './governor.js';
import {
  ALERTS_USER_AGENT,
  UpstreamError,
  fetchUpstreamText,
  upstreamErrorCode,
} from './http.js';

const clock = (start = 1_000_000) => {
  let at = start;
  return { now: () => at, advance: (ms) => (at += ms) };
};

test('upstream failures become short codes, never upstream text', () => {
  assert.equal(
    upstreamErrorCode(new UpstreamError('http', { status: 503 })),
    'http_503',
  );
  assert.equal(
    upstreamErrorCode(new UpstreamError('invalid_payload')),
    'invalid_payload',
  );
  assert.equal(
    upstreamErrorCode(
      new UpstreamError('Upstream said <html>secret key=abc</html>'),
    ),
    'unavailable',
  );
  assert.equal(
    upstreamErrorCode(
      Object.assign(new Error('x'), { code: 'RESPONSE_TOO_LARGE' }),
    ),
    'too_large',
  );
  assert.equal(
    upstreamErrorCode(Object.assign(new Error('x'), { name: 'AbortError' })),
    'timeout',
  );
  assert.equal(
    upstreamErrorCode(new SyntaxError('Unexpected token <')),
    'invalid_payload',
  );
  assert.equal(
    upstreamErrorCode(
      new TypeError('fetch failed: https://example.invalid/?API_KEY=abc'),
    ),
    'network',
  );
  assert.equal(
    upstreamErrorCode(new Error('https://example.invalid/?key=abc')),
    'unavailable',
  );
  assert.equal(upstreamErrorCode(null), 'unavailable');
});

test('a read carries the identifying User-Agent and refuses foreign redirects', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), init });
    if (String(url) === 'https://a.example/feed')
      return new Response(null, {
        status: 301,
        headers: { location: 'https://www.a.example/feed' },
      });
    if (String(url) === 'https://www.a.example/feed')
      return new Response('<rss/>', {
        headers: { 'content-type': 'application/rss+xml' },
      });
    return new Response(null, {
      status: 302,
      headers: { location: 'https://elsewhere.example/feed' },
    });
  };
  const followed = await fetchUpstreamText('https://a.example/feed', {
    fetchImpl,
    redirectHosts: ['a.example', 'www.a.example'],
  });
  assert.equal(followed.payload, '<rss/>');
  assert.equal(followed.url, 'https://www.a.example/feed');
  assert.equal(seen[0].init.headers['User-Agent'], ALERTS_USER_AGENT);
  assert.equal(seen[0].init.redirect, 'manual');
  await assert.rejects(
    fetchUpstreamText('https://b.example/feed', {
      fetchImpl,
      redirectHosts: ['b.example'],
    }),
    (error) => upstreamErrorCode(error) === 'redirect_refused',
  );
  await assert.rejects(
    fetchUpstreamText('https://a.example/feed', { fetchImpl }),
    (error) => upstreamErrorCode(error) === 'redirect_refused',
  );
});

test('a failing status reports only its code and cancels the body', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('upstream secret text'));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    fetchUpstreamText('https://a.example/x', {
      fetchImpl: async () => new Response(body, { status: 500 }),
    }),
    (error) => {
      assert.equal(upstreamErrorCode(error), 'http_500');
      assert.doesNotMatch(String(error.message), /secret/);
      return true;
    },
  );
  assert.equal(cancelled, true);
});

test('the governor caches, coalesces, budgets and serves a stale copy', async () => {
  const time = clock();
  const governor = createFeedGovernor({
    id: 'fixture',
    ttlMs: 60_000,
    staleMaxMs: 10 * 60_000,
    budgetPerHour: 3,
    cooldownMs: 30_000,
    now: time.now,
  });
  let loads = 0;
  let fail = false;
  const load = async () => {
    loads += 1;
    if (fail) throw new UpstreamError('http', { status: 503 });
    return { n: loads };
  };
  const [a, b] = await Promise.all([
    governor.acquire(load),
    governor.acquire(load),
  ]);
  assert.equal(loads, 1, 'concurrent misses share one load');
  assert.deepEqual([a.value, b.value], [{ n: 1 }, { n: 1 }]);
  assert.equal(a.status, 'ok');
  time.advance(30_000);
  assert.equal((await governor.acquire(load)).value.n, 1, 'inside the TTL');
  assert.equal(loads, 1);

  time.advance(40_000);
  fail = true;
  const stale = await governor.acquire(load);
  assert.equal(stale.status, 'stale');
  assert.equal(stale.stale, true);
  assert.equal(stale.value.n, 1);
  assert.equal(governor.describe().lastError, 'http_503');
  const cooling = await governor.acquire(load);
  assert.equal(cooling.status, 'cooldown');
  assert.equal(loads, 2, 'the cooldown keeps upstream unasked');

  time.advance(31_000);
  fail = false;
  assert.equal((await governor.acquire(load)).value.n, 3);
  time.advance(61_000);
  const budget = await governor.acquire(load);
  assert.equal(
    budget.status,
    'budget',
    'three loads in the hour spend the budget',
  );
  assert.equal(loads, 3);

  time.advance(11 * 60_000);
  fail = true;
  await assert.rejects(governor.acquire(load), (error) => {
    assert.equal(error.code, 'budget');
    return true;
  });
  assert.equal(governor.describe().status, 'unavailable');
  governor.reset();
  assert.equal(governor.describe().fetchedAt, null);
});

test('a failure with no copy reports the failure code', async () => {
  const governor = createFeedGovernor({ id: 'empty', ttlMs: 1000 });
  await assert.rejects(
    governor.acquire(async () => {
      throw new SyntaxError('Unexpected token < in JSON at position 0');
    }),
    (error) => {
      assert.equal(error.code, 'invalid_payload');
      assert.doesNotMatch(error.message, /Unexpected token/);
      return true;
    },
  );
  assert.throws(() => createFeedGovernor({ ttlMs: 1 }), /needs an id/);
  assert.throws(() => createFeedGovernor({ id: 'x', ttlMs: 0 }), /ttlMs/);
});
