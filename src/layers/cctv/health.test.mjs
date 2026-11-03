import assert from 'node:assert/strict';
import test from 'node:test';
import { createHealth } from './health.js';

function harness(responses) {
  const state = {
    _lastHealthSyncAt: 0,
    _healthById: new Map(),
    _streamHealthById: new Map(),
    _sourceAbort: new AbortController(),
  };
  let notified = 0;
  const health = createHealth({
    state,
    services: {},
    parts: {
      model: { safeNumber: (value, fallback) => Number(value) || fallback },
      presentation: {
        notifyListeners: () => {
          notified += 1;
        },
      },
    },
    source: { getHealth: async () => responses.shift() },
  });
  return { state, health, notified: () => notified };
}

test('a health poll carries the stream record and keeps the map instance while nothing changed', async () => {
  const h = harness([
    {
      cameras: [{ id: 'a', status: 'ok' }],
      streams: { a: { ok: 10, fail: 0 }, b: { ok: 0, fail: 9 } },
    },
    { cameras: [], streams: { a: { ok: 10, fail: 0 }, b: { ok: 0, fail: 9 } } },
    { cameras: [], streams: { a: { ok: 12, fail: 0 } } },
    { cameras: [] },
  ]);
  await h.health.syncHealthState(true);
  const first = h.state._streamHealthById;
  assert.deepEqual(
    [...first.entries()],
    [
      ['a', { ok: 10, fail: 0 }],
      ['b', { ok: 0, fail: 9 }],
    ],
  );
  assert.equal(h.state._healthById.get('a').status, 'ok');
  await h.health.syncHealthState(true);
  assert.equal(h.state._streamHealthById, first);
  await h.health.syncHealthState(true);
  const third = h.state._streamHealthById;
  assert.notEqual(third, first);
  assert.deepEqual([...third.keys()], ['a']);
  // A proxy without a record leaves the last one standing.
  await h.health.syncHealthState(true);
  assert.equal(h.state._streamHealthById, third);
  assert.equal(h.notified(), 0);
});

test('a probe answer merges into the record and notifies only when it changed', async () => {
  const h = harness([{ cameras: [], streams: { a: { ok: 10, fail: 0 } } }]);
  await h.health.syncHealthState(true);
  const before = h.state._streamHealthById;
  assert.equal(h.health.mergeStreamHealth({ a: { ok: 10, fail: 0 } }), false);
  assert.equal(h.state._streamHealthById, before);
  assert.equal(h.notified(), 0);
  assert.equal(h.health.mergeStreamHealth({ b: { ok: 0, fail: 4 } }), true);
  assert.deepEqual(
    [...h.state._streamHealthById.entries()],
    [
      ['a', { ok: 10, fail: 0 }],
      ['b', { ok: 0, fail: 4 }],
    ],
  );
  assert.equal(h.notified(), 1);
  assert.equal(h.health.mergeStreamHealth(null), false);
  assert.equal(h.health.mergeStreamHealth({}), false);
  assert.equal(h.notified(), 1);
});
