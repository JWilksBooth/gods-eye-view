import test from 'node:test';
import assert from 'node:assert/strict';
import { greatCircleKm } from '../geoDistance.js';
import {
  LIVE_OPS_LAYERS,
  LIVE_OPS_REGIONS,
  liveOpsRegion,
  liveOpsRegionLayers,
} from './liveOpsRegions.js';
import { getTransitFeed } from './transitFeeds.js';

/** Distance from a point to the nearest point of a [west, south, east, north] box. */
function kmToBox(point, [west, south, east, north]) {
  const lat = Math.min(Math.max(point.lat, south), north);
  const lon = Math.min(Math.max(point.lon, west), east);
  return greatCircleKm(point, { lat, lon });
}

test('every region names only registered, enabled transit feeds whose coverage reaches it', () => {
  for (const region of LIVE_OPS_REGIONS) {
    assert.ok(Array.isArray(region.transit), `${region.id} lists feeds`);
    assert.ok(Object.isFrozen(region.transit));
    assert.ok(region.transit.length > 0, `${region.id} has a live feed`);
    for (const id of region.transit) {
      const feed = getTransitFeed(id);
      assert.ok(feed, `${id} is registered and enabled`);
      assert.ok(
        kmToBox(feed.center, region.bbox) <= feed.loadRadiusKm,
        `${id} is polled somewhere inside ${region.name}`,
      );
    }
  }
});

test('the four regions cover the feeds the console was asked for', () => {
  assert.deepEqual(liveOpsRegion('los-angeles').transit, [
    'lametro-bus',
    'lametro-rail',
    'metrolink',
    'octa',
  ]);
  assert.deepEqual(liveOpsRegion('sonoma-county').transit, ['sf511-bay-area']);
  assert.deepEqual(liveOpsRegion('sf-bay-area').transit, [
    'sf511-bay-area',
    'mvgo-mountain-view',
  ]);
  assert.deepEqual(liveOpsRegion('las-vegas').transit, ['rtc-southern-nevada']);
});

test('a region with a feed turns Transit on with the console layers; one without does not', () => {
  for (const region of LIVE_OPS_REGIONS) {
    assert.deepEqual(liveOpsRegionLayers(region), [
      ...LIVE_OPS_LAYERS,
      'transit',
    ]);
  }
  assert.deepEqual(liveOpsRegionLayers({ transit: [] }), [...LIVE_OPS_LAYERS]);
  assert.deepEqual(liveOpsRegionLayers({}), [...LIVE_OPS_LAYERS]);
  assert.deepEqual(liveOpsRegionLayers(null), [...LIVE_OPS_LAYERS]);
  assert.equal(LIVE_OPS_LAYERS.includes('transit'), false);
});
