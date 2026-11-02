// The LIVE OPS region feeds, decoded the way the proxy decodes them: one
// protobuf fixture per feed, built from src/data/fixtures/transit-region-feeds.json,
// through buildTransitSnapshot, then judged by the registry's mode and label
// rules and by whether the vehicles land inside their region's box.
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PbfWriter } from 'pbf';
import { buildTransitSnapshot } from './transitProxy.js';
import {
  getTransitFeed,
  transitFeedsInRange,
  transitModeFor,
  transitModeResolved,
  transitRouteLabel,
} from './transitFeeds.js';
import { LIVE_OPS_REGIONS, regionContains } from './liveOpsRegions.js';

const FIXTURE = JSON.parse(
  readFileSync(
    new URL('./fixtures/transit-region-feeds.json', import.meta.url),
  ),
);

/** Encode a nested message with a fresh writer and embed it as a bytes field. */
function embed(writer, tag, build) {
  const inner = new PbfWriter();
  build(inner);
  writer.writeBytesField(tag, inner.finish());
}

/** A FeedMessage of VehiclePositions, from the proto field numbers. */
function encodeFeed(entities, headerTimestamp) {
  const writer = new PbfWriter();
  embed(writer, 1, (header) => {
    header.writeStringField(1, '2.0');
    header.writeVarintField(2, 0);
    header.writeVarintField(3, headerTimestamp);
  });
  for (const item of entities) {
    embed(writer, 2, (entity) => {
      entity.writeStringField(1, item.entityId);
      embed(entity, 4, (vehicle) => {
        embed(vehicle, 1, (trip) => {
          trip.writeStringField(1, item.tripId);
          trip.writeStringField(5, item.routeId);
        });
        embed(vehicle, 2, (position) => {
          position.writeFloatField(1, item.lat);
          position.writeFloatField(2, item.lon);
          position.writeFloatField(3, item.bearing);
          position.writeFloatField(5, item.speed);
        });
        vehicle.writeVarintField(5, item.timestamp);
        embed(vehicle, 8, (descriptor) => {
          descriptor.writeStringField(1, item.vehicleId);
          descriptor.writeStringField(2, item.label);
        });
      });
    });
  }
  return writer.finish();
}

const NOW_MS = FIXTURE.headerTimestamp * 1000 + 2_000;

/** The regions whose registry entries list this feed. */
function regionsOf(feedId) {
  return LIVE_OPS_REGIONS.filter((region) => region.transit.includes(feedId));
}

for (const [feedId, entities] of Object.entries(FIXTURE.feeds)) {
  test(`${feedId}: the fixture decodes to its vehicles, inside its region, with the feed's own timestamps`, () => {
    const feed = getTransitFeed(feedId);
    assert.ok(feed, `${feedId} is registered and enabled`);
    const snapshot = buildTransitSnapshot(
      feed,
      encodeFeed(entities, FIXTURE.headerTimestamp),
      NOW_MS,
    );
    assert.equal(snapshot.feedId, feedId);
    assert.equal(snapshot.count, entities.length);
    assert.equal(snapshot.feedTimestamp, FIXTURE.headerTimestamp);
    const regions = regionsOf(feedId);
    assert.ok(regions.length, `${feedId} belongs to a LIVE OPS region`);
    for (const vehicle of snapshot.vehicles) {
      assert.equal(vehicle.timestampSource, 'vehicle');
      assert.ok(
        regions.some((region) => regionContains(region, vehicle)),
        `${vehicle.id} lies inside ${regions.map((r) => r.name).join(' or ')}`,
      );
      assert.ok(
        transitFeedsInRange(vehicle.lat, vehicle.lon).some(
          (entry) => entry.id === feedId,
        ),
        `${feedId} is polled where ${vehicle.id} is`,
      );
      assert.ok(Number.isFinite(vehicle.bearing) && vehicle.speedMps >= 0);
    }
  });
}

test('511 regional vehicles take their mode and name from the operator prefix', () => {
  const feed = getTransitFeed('sf511-bay-area');
  const byId = Object.fromEntries(
    buildTransitSnapshot(
      feed,
      encodeFeed(FIXTURE.feeds['sf511-bay-area'], FIXTURE.headerTimestamp),
      NOW_MS,
    ).vehicles.map((vehicle) => [vehicle.id, vehicle]),
  );
  const expect = (id, mode, label) => {
    const vehicle = byId[id];
    assert.ok(vehicle, `${id} decoded`);
    assert.equal(transitModeFor(feed, vehicle.routeId, vehicle.id), mode);
    assert.equal(transitModeResolved(feed, vehicle.routeId, vehicle.id), true);
    assert.equal(transitRouteLabel(feed, vehicle.routeId), label);
  };
  expect('SF:1234', 'bus', 'Muni 14');
  expect('SF:2041', 'tram', 'Muni N');
  expect('BA:1403', 'subway', 'BART Yellow-N');
  expect('CT:128', 'rail', 'Caltrain Local Weekday');
  expect('SA:104', 'rail', 'SMART SMART');
  expect('SC:8521', 'bus', 'Sonoma County Transit 60');
  // Vehicle ids keep their operator prefix, so two operators' bus 1234 never
  // collapse into one dot.
  assert.equal(byId['SF:1234'].id, 'SF:1234');
});

test('LA Metro bus routes drop the timetable suffix and name the BRT lines', () => {
  const bus = getTransitFeed('lametro-bus');
  assert.equal(transitRouteLabel(bus, '2-13201'), '2');
  assert.equal(transitRouteLabel(bus, '910-13201'), 'J Line');
  assert.equal(transitRouteLabel(bus, '901-13196'), 'G Line');
  assert.equal(transitModeFor(bus, '2-13201'), 'bus');
  assert.equal(transitRouteLabel(bus, null), null);
});

test('LA Metro rail lines are named, and the subway is told from light rail', () => {
  const rail = getTransitFeed('lametro-rail');
  assert.equal(transitRouteLabel(rail, '801'), 'A Line');
  assert.equal(transitModeFor(rail, '801'), 'tram');
  assert.equal(transitModeFor(rail, '802'), 'subway');
  assert.equal(transitModeFor(rail, '805'), 'subway');
  assert.equal(transitModeFor(rail, '807'), 'tram');
  assert.equal(transitModeResolved(rail, '802'), true);
  // An unlisted route keeps the feed default and is only a guess.
  assert.equal(transitModeFor(rail, '899'), 'tram');
  assert.equal(transitModeResolved(rail, '899'), false);
  assert.equal(transitRouteLabel(rail, '899'), '899');
});

test('RTC and MVgo internal route keys become the names on the vehicles', () => {
  const rtc = getTransitFeed('rtc-southern-nevada');
  assert.equal(transitRouteLabel(rtc, '4778'), 'DEUCE');
  assert.equal(transitRouteLabel(rtc, '4760'), 'RED LINE');
  assert.equal(transitRouteLabel(rtc, '4741'), '101');
  assert.equal(transitRouteLabel(rtc, '9999'), '9999');
  const mvgo = getTransitFeed('mvgo-mountain-view');
  assert.equal(transitRouteLabel(mvgo, '5783'), 'A - AM');
  assert.equal(transitRouteLabel(mvgo, '5791'), 'D - PM Concert');
  // OCTA publishes the number on the bus as the route id already.
  assert.equal(transitRouteLabel(getTransitFeed('octa'), '50'), '50');
  assert.equal(transitModeFor(getTransitFeed('metrolink'), 'Any'), 'rail');
});
