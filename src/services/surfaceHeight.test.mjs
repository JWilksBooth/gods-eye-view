import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sampleRenderedSurfaceHeight,
  surfaceHeightSupported,
} from './surfaceHeight.js';

const carto = { longitude: -2.1, latitude: 0.66, height: 0 };

test('the CPU height wins and the pick render is never issued when both exist', () => {
  let picks = 0;
  const scene = {
    getHeight: () => 137.5,
    sampleHeight: () => {
      picks += 1;
      return 999;
    },
  };
  assert.equal(sampleRenderedSurfaceHeight(scene, carto), 137.5);
  assert.equal(picks, 0);
});

test('an unloaded cell is undefined, not a pick render', () => {
  let picks = 0;
  const scene = {
    getHeight: () => undefined,
    sampleHeight: () => {
      picks += 1;
      return 12;
    },
  };
  assert.equal(sampleRenderedSurfaceHeight(scene, carto), undefined);
  assert.equal(picks, 0);
  assert.equal(
    sampleRenderedSurfaceHeight({ getHeight: () => Number.NaN }, carto),
    undefined,
  );
  assert.equal(
    sampleRenderedSurfaceHeight(
      {
        getHeight: () => {
          throw new Error('mid-teardown');
        },
      },
      carto,
    ),
    undefined,
  );
});

test('a scene without the CPU path falls back to the pick render with its exclusions', () => {
  const seen = [];
  const scene = {
    sampleHeight: (position, exclude) => {
      seen.push([position, exclude]);
      return 41;
    },
  };
  const excludeObjects = ['a00001'];
  assert.equal(
    sampleRenderedSurfaceHeight(scene, carto, { excludeObjects }),
    41,
  );
  assert.deepEqual(seen, [[carto, excludeObjects]]);
  assert.equal(
    sampleRenderedSurfaceHeight(
      {
        sampleHeight: () => {
          throw new Error('no depth texture');
        },
      },
      carto,
    ),
    undefined,
  );
});

test('missing inputs and unsupported scenes answer undefined', () => {
  assert.equal(sampleRenderedSurfaceHeight(null, carto), undefined);
  assert.equal(
    sampleRenderedSurfaceHeight({ getHeight: () => 1 }, null),
    undefined,
  );
  assert.equal(sampleRenderedSurfaceHeight({}, carto), undefined);
  assert.equal(surfaceHeightSupported({}), false);
  assert.equal(surfaceHeightSupported(null), false);
  assert.equal(surfaceHeightSupported({ getHeight() {} }), true);
  assert.equal(surfaceHeightSupported({ sampleHeight() {} }), true);
});
