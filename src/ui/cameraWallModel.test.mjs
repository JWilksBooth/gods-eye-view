import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CAMERA_WALL_SIZES,
  normalizeWallSize,
  planWallVideo,
  wallColumns,
  wallLiveCapacity,
} from './cameraWallModel.js';
import { CCTV_HLS_SESSION_LIMIT } from '../sources/cctvStreamBudget.js';

test('wall sizes are 4, 6 or 9 tiles in two or three columns', () => {
  assert.deepEqual([...CAMERA_WALL_SIZES], [4, 6, 9]);
  assert.equal(normalizeWallSize('9'), 9);
  assert.equal(normalizeWallSize(5), 6);
  assert.equal(normalizeWallSize(undefined), 6);
  assert.equal(wallColumns(4), 2);
  assert.equal(wallColumns(6), 3);
  assert.equal(wallColumns(9), 3);
});

test('the plan never exceeds the proxy session limit', () => {
  const plan = planWallVideo({
    limit: 2,
    pinned: ['a', 'b', 'c'],
    hover: 'd',
  });
  assert.deepEqual(plan.video, ['c', 'b']);
  assert.deepEqual(plan.evicted, ['a']);
  assert.equal(plan.hoverRefused, true);
  assert.equal(planWallVideo().video.length, 0);
  assert.equal(planWallVideo({ limit: CCTV_HLS_SESSION_LIMIT }).video.length, 0);
});

test('the newest pin wins and the oldest is evicted', () => {
  const plan = planWallVideo({ limit: 1, pinned: ['old', 'new'] });
  assert.deepEqual(plan.video, ['new']);
  assert.deepEqual(plan.evicted, ['old']);
});

test('a hover takes a free slot and never evicts a pin', () => {
  assert.deepEqual(
    planWallVideo({ limit: 2, pinned: ['a'], hover: 'b' }).video,
    ['a', 'b'],
  );
  const full = planWallVideo({ limit: 2, pinned: ['a', 'b'], hover: 'c' });
  assert.deepEqual(full.video, ['b', 'a']);
  assert.equal(full.hoverRefused, true);
  assert.deepEqual(full.evicted, []);
  // Hovering a pinned tile changes nothing.
  const same = planWallVideo({ limit: 2, pinned: ['a'], hover: 'a' });
  assert.deepEqual(same.video, ['a']);
  assert.equal(same.hoverRefused, false);
});

test('a camera the layer already streams counts once: free on the wall, a slot off it', () => {
  // The layer streams X. The wall shows X too: sharing it costs nothing, so
  // one more camera fits beside it.
  const shared = planWallVideo({
    limit: 2,
    pinned: ['x', 'y'],
    external: ['x'],
  });
  assert.deepEqual(shared.video, ['y', 'x']);
  assert.deepEqual(shared.evicted, []);
  // The layer streams Z, which the wall does not show: only one wall slot.
  const held = planWallVideo({
    limit: 2,
    pinned: ['x', 'y'],
    external: ['z'],
  });
  assert.deepEqual(held.video, ['y']);
  assert.deepEqual(held.evicted, ['x']);
  assert.equal(wallLiveCapacity({ limit: 2, external: ['z'], shown: ['x', 'y'] }), 1);
  assert.equal(wallLiveCapacity({ limit: 2, external: ['x'], shown: ['x', 'y'] }), 2);
  assert.equal(wallLiveCapacity({ limit: 2, external: ['z', 'w'] }), 0);
});

test('a recently refused camera is skipped so the wall does not hammer the proxy', () => {
  const plan = planWallVideo({
    limit: 2,
    pinned: ['a', 'b'],
    hover: 'b',
    refused: ['b'],
  });
  assert.deepEqual(plan.video, ['a']);
  assert.deepEqual(plan.evicted, ['b']);
  assert.equal(plan.hoverRefused, true);
});

test('duplicate pins and blank ids are ignored', () => {
  const plan = planWallVideo({ limit: 3, pinned: ['a', '', 'a', null, 'b'] });
  assert.deepEqual(plan.video, ['b', 'a']);
});

test('a camera whose stream is known to be down never gets a session: no hover, no pin, and a pin that goes down is evicted', () => {
  const plan = planWallVideo({
    limit: 2,
    pinned: ['a', 'b'],
    hover: 'c',
    dead: ['b', 'c'],
  });
  assert.deepEqual(plan.video, ['a']);
  assert.deepEqual(plan.evicted, ['b']);
  assert.equal(plan.hoverRefused, true);
  // The slot a dead pin gives up goes to a live hover.
  assert.deepEqual(
    planWallVideo({ limit: 2, pinned: ['a', 'b'], hover: 'c', dead: ['b'] })
      .video,
    ['a', 'c'],
  );
});
