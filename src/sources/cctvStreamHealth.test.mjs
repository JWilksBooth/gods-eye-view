import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CCTV_STREAM_FAILURE_WINDOW_MS,
  CCTV_STREAM_OK_WINDOW_MS,
  readStreamHealth,
  sameStreamHealth,
  streamHealthState,
} from './cctvStreamHealth.js';

const NOW = 1_700_000_000_000;

test('a stream is down for the failure window after its last failure, then unknown', () => {
  assert.equal(streamHealthState({ ok: 0, fail: NOW - 1 }, NOW), 'down');
  assert.equal(
    streamHealthState(
      { ok: 0, fail: NOW - CCTV_STREAM_FAILURE_WINDOW_MS + 1 },
      NOW,
    ),
    'down',
  );
  assert.equal(
    streamHealthState({ ok: 0, fail: NOW - CCTV_STREAM_FAILURE_WINDOW_MS }, NOW),
    'unknown',
  );
});

test('a stream is ok for the success window after its last success, then unknown', () => {
  assert.equal(streamHealthState({ ok: NOW - 1, fail: 0 }, NOW), 'ok');
  assert.equal(
    streamHealthState({ ok: NOW - CCTV_STREAM_OK_WINDOW_MS + 1, fail: 0 }, NOW),
    'ok',
  );
  assert.equal(
    streamHealthState({ ok: NOW - CCTV_STREAM_OK_WINDOW_MS, fail: 0 }, NOW),
    'unknown',
  );
});

test('the later verdict wins, and a success at the same instant clears a failure', () => {
  assert.equal(streamHealthState({ ok: NOW - 5_000, fail: NOW - 1_000 }, NOW), 'down');
  assert.equal(streamHealthState({ ok: NOW - 1_000, fail: NOW - 5_000 }, NOW), 'ok');
  assert.equal(streamHealthState({ ok: NOW, fail: NOW }, NOW), 'ok');
  // An old failure after an older success: nothing recent to trust.
  assert.equal(
    streamHealthState(
      { ok: NOW - CCTV_STREAM_OK_WINDOW_MS * 2, fail: NOW - CCTV_STREAM_OK_WINDOW_MS },
      NOW,
    ),
    'unknown',
  );
});

test('no record, an empty record or junk is unknown', () => {
  assert.equal(streamHealthState(undefined, NOW), 'unknown');
  assert.equal(streamHealthState(null, NOW), 'unknown');
  assert.equal(streamHealthState({}, NOW), 'unknown');
  assert.equal(streamHealthState({ ok: 'soon', fail: NaN }, NOW), 'unknown');
});

test('a health response reads into a map of clean timestamps', () => {
  const map = readStreamHealth({
    a: { ok: NOW, fail: 0 },
    ' b ': { ok: '12', fail: -4 },
    c: 'nope',
    '': { ok: 1, fail: 1 },
    d: { ok: 'x', fail: 'y' },
  });
  assert.deepEqual(
    [...map.entries()],
    [
      ['a', { ok: NOW, fail: 0 }],
      ['b', { ok: 12, fail: 0 }],
      ['d', { ok: 0, fail: 0 }],
    ],
  );
  assert.equal(readStreamHealth(null).size, 0);
  assert.equal(readStreamHealth([1]).size, 0);
});

test('two maps compare by content, so an unchanged poll keeps its instance', () => {
  const a = readStreamHealth({ a: { ok: 1, fail: 0 } });
  const b = readStreamHealth({ a: { ok: 1, fail: 0 } });
  const c = readStreamHealth({ a: { ok: 2, fail: 0 } });
  const d = readStreamHealth({ a: { ok: 1, fail: 0 }, b: { ok: 0, fail: 1 } });
  assert.equal(sameStreamHealth(a, b), true);
  assert.equal(sameStreamHealth(a, a), true);
  assert.equal(sameStreamHealth(a, c), false);
  assert.equal(sameStreamHealth(a, d), false);
  assert.equal(sameStreamHealth(null, a), false);
});
