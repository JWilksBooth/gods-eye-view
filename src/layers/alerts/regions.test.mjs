import assert from 'node:assert/strict';
import test from 'node:test';
import { LIVE_OPS_REGIONS } from '../../data/liveOpsRegions.js';
import {
  ALERT_AIRPORTS,
  ALERT_CALTRANS_DISTRICTS,
  ALERT_COUNTY_CENTROIDS,
  ALERT_NWS_AREAS,
  ALERT_REGIONS,
  ALERT_REGION_FEEDS,
  ALERT_REGION_IDS,
  alertRegion,
  bboxContains,
  bboxIntersects,
  regionsForAirport,
  regionsForBbox,
  regionsForCountyFips,
  regionsForPoint,
  regionsForState,
  regionsForText,
  regionsForUgc,
} from './regions.js';

test('the alert regions are the LIVE OPS regions, not a copy of them', () => {
  assert.deepEqual(
    ALERT_REGION_IDS,
    LIVE_OPS_REGIONS.map((region) => region.id),
  );
  LIVE_OPS_REGIONS.forEach((region, index) => {
    const alerts = ALERT_REGIONS[index];
    assert.equal(alerts.id, region.id);
    assert.equal(alerts.name, region.name);
    assert.equal(alerts.bbox, region.bbox, 'the same box object');
    assert.equal(
      alerts.anchor,
      region.center,
      'bulletins gather at the centre',
    );
  });
  assert.deepEqual(
    Object.keys(ALERT_REGION_FEEDS).sort(),
    [...ALERT_REGION_IDS].sort(),
  );
});

test('alert-specific ids stay consistent with the region boxes', () => {
  for (const region of ALERT_REGIONS) {
    for (const code of region.airports) {
      const airport = ALERT_AIRPORTS[code];
      assert.ok(airport, `${code} has coordinates`);
      assert.ok(
        bboxContains(region.bbox, airport.lon, airport.lat),
        `${code} lies inside ${region.id}`,
      );
    }
    assert.equal(
      region.countyFips.length,
      region.ugcCounties.length,
      region.id,
    );
    for (const fips of region.countyFips) {
      const centre = ALERT_COUNTY_CENTROIDS[fips];
      if (centre)
        assert.ok(
          bboxContains(region.bbox, centre.lon, centre.lat),
          `${fips} centre lies inside ${region.id}`,
        );
    }
  }
  for (const [fips, centre] of Object.entries(ALERT_COUNTY_CENTROIDS))
    assert.ok(
      ALERT_REGIONS.some(
        (region) =>
          region.countyFips.includes(fips) &&
          bboxContains(region.bbox, centre.lon, centre.lat),
      ),
      `${fips} belongs to a region whose box holds its centre`,
    );
  assert.deepEqual(ALERT_NWS_AREAS, ['CA', 'NV']);
  assert.deepEqual(ALERT_CALTRANS_DISTRICTS, [4, 7, 12]);
});

test('a region matches statewide bulletins by its public name only', () => {
  // Keywords are public place names. Sonoma County is matched by its region
  // name alone; no town inside it is listed.
  assert.deepEqual(alertRegion('sonoma-county').keywords, ['Sonoma County']);
  assert.deepEqual(regionsForText('Red flag warning for Sonoma County hills'), [
    'sonoma-county',
  ]);
  assert.deepEqual(regionsForText('Storm prep in San Francisco and Oakland'), [
    'sf-bay-area',
  ]);
  assert.deepEqual(regionsForText('Shelter opened in North Las Vegas'), [
    'las-vegas',
  ]);
  assert.deepEqual(regionsForText('A Long Beach advisory; L.A. crews assist'), [
    'los-angeles',
  ]);
  assert.deepEqual(regionsForText('Henderson’s nephew'), ['las-vegas']);
  assert.deepEqual(regionsForText('Hollywoodland'), [], 'whole words only');
  assert.deepEqual(regionsForText(''), []);
});

test('membership helpers answer by box, county, zone, airport and state', () => {
  assert.deepEqual(regionsForPoint(-118.25, 34.05), ['los-angeles']);
  assert.deepEqual(regionsForPoint(-122.4, 38.1), [
    'sonoma-county',
    'sf-bay-area',
  ]);
  assert.deepEqual(regionsForPoint(-100, 40), []);
  assert.deepEqual(regionsForBbox([-115.5, 36, -115, 36.2]), ['las-vegas']);
  assert.deepEqual(regionsForCountyFips(['006097']), ['sonoma-county']);
  assert.deepEqual(regionsForCountyFips(['006059', '032003']), [
    'los-angeles',
    'las-vegas',
  ]);
  assert.deepEqual(regionsForUgc(['cac075']), ['sf-bay-area']);
  assert.deepEqual(regionsForAirport('las'), ['las-vegas']);
  assert.deepEqual(regionsForAirport('JFK'), []);
  assert.deepEqual(regionsForState('NV'), ['las-vegas']);
  assert.equal(regionsForState('CA').length, 3);
  assert.equal(alertRegion('LAS-VEGAS').name, 'Las Vegas');
  assert.equal(alertRegion('atlantis'), null);
  assert.equal(bboxIntersects([0, 0, 1, 1], [1, 1, 2, 2]), true);
  assert.equal(bboxIntersects([0, 0, 1, 1], [2, 2, 3, 3]), false);
});
