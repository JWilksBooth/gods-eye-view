import assert from 'node:assert/strict';
import test from 'node:test';
import { createAlertsSource } from './source.js';

const json = (value, init = {}) =>
  new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
    ...init,
  });

test('the source asks the same-origin proxy and narrows by query', async () => {
  const asked = [];
  const source = createAlertsSource({
    fetchImpl: async (url, init) => {
      asked.push({ url, init });
      return json({
        schemaVersion: 1,
        fetchedAt: '2026-11-01T17:00:00.000Z',
        stale: true,
        region: 'las-vegas',
        regions: [{ id: 'las-vegas' }],
        sources: [{ id: 'nws', status: 'ok' }],
        alerts: [{ id: 'a' }, null, { nope: true }],
      });
    },
  });
  const all = await source.getSnapshot();
  assert.equal(asked[0].url, '/api/alerts');
  assert.equal(asked[0].init.cache, 'no-store');
  assert.deepEqual(all.alerts, [{ id: 'a' }]);
  assert.equal(all.stale, true);
  assert.equal(all.region, 'las-vegas');
  await source.getSnapshot({
    region: 'las-vegas',
    kinds: ['road', 'air'],
    minSeverity: 'moderate',
  });
  assert.equal(
    asked[1].url,
    '/api/alerts?region=las-vegas&kind=road%2Cair&severity=moderate',
  );
});

test('failures and malformed answers are refused, not drawn empty', async () => {
  const limited = createAlertsSource({
    fetchImpl: async () => json({ error: 'rate_limited' }, { status: 429 }),
  });
  await assert.rejects(limited.getSnapshot(), (error) => {
    assert.equal(error.message, 'Alerts feed rate limited (HTTP 429)');
    assert.equal(error.retryable, true);
    assert.equal(error.retryAfterMs, 60_000);
    return true;
  });
  const down = createAlertsSource({
    fetchImpl: async () => json({ error: 'x' }, { status: 502 }),
  });
  await assert.rejects(down.getSnapshot(), /HTTP 502/);
  const malformed = createAlertsSource({
    fetchImpl: async () => json({ alerts: 'nope' }),
  });
  await assert.rejects(malformed.getSnapshot(), /Malformed alerts snapshot/);
  await assert.rejects(malformed.getAirports(), /Malformed airport status/);
  const airports = createAlertsSource({
    fetchImpl: async (url) => {
      assert.equal(url, '/api/alerts/airports');
      return json({ airports: [], events: [], status: 'ok' });
    },
  });
  assert.equal((await airports.getAirports()).status, 'ok');
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    createAlertsSource({ fetchImpl: async () => json({}) }).getSnapshot({
      signal: aborted.signal,
    }),
  );
});
