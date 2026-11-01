import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AIRPORT_STATUS_KINDS,
  ALERT_KIND_IDS,
  ALERT_SEVERITIES,
  ALERT_SEVERITY_IDS,
  alertAnchor,
  alertIsCurrent,
  alertSeverity,
  alertTouchesBbox,
  clampText,
  compareAlerts,
  countBySeverity,
  createAlert,
  feedFreshness,
  filterAlerts,
  geometryBbox,
  isoOrNull,
  mapAlertAnalystRecord,
  normalizeSeverity,
  severityRank,
  validateAlertGeometry,
} from './model.js';

const NOW = Date.parse('2026-11-01T17:00:00Z');
const ring = [
  [-118.4, 34.0],
  [-118.2, 34.0],
  [-118.2, 34.2],
  [-118.4, 34.2],
  [-118.4, 34.0],
];

const base = {
  id: 'nws:1',
  source: 'nws',
  kind: 'weather',
  severity: 'Severe',
  agency: 'NWS Fixture Office',
  headline: '  Wind   Advisory ',
  regions: ['los-angeles', 'atlantis', 'los-angeles'],
  area: { type: 'Polygon', coordinates: [ring] },
  starts: '2026-11-01T16:00:00Z',
  ends: '2026-11-02T06:00:00Z',
  issued: NOW - 3_600_000,
  url: 'https://www.weather.gov/lox/',
};

test('severity bands name theme tokens and carry no colours', () => {
  assert.deepEqual(ALERT_SEVERITY_IDS, [
    'extreme',
    'severe',
    'moderate',
    'minor',
    'unknown',
  ]);
  for (const band of ALERT_SEVERITIES) {
    assert.equal(band.token, `--alert-severity-${band.id}`);
    assert.deepEqual(Object.keys(band).sort(), [
      'id',
      'label',
      'rank',
      'token',
    ]);
  }
  assert.equal(severityRank('extreme'), 4);
  assert.equal(alertSeverity('bogus').id, 'unknown');
  assert.equal(normalizeSeverity('Severe'), 'severe');
  assert.equal(normalizeSeverity('WARNING'), 'severe');
  assert.equal(normalizeSeverity('watch'), 'moderate');
  assert.equal(normalizeSeverity('INFO'), 'minor');
  assert.equal(normalizeSeverity('Unknown'), 'unknown');
  assert.equal(normalizeSeverity(''), 'unknown');
  assert.deepEqual(Object.keys(AIRPORT_STATUS_KINDS).sort(), [
    'closure',
    'delay',
    'ground_delay',
    'ground_stop',
    'restriction',
  ]);
});

test('an alert is created only with its required fields and is normalized', () => {
  const alert = createAlert(base, { fetchedAt: NOW });
  assert.equal(alert.headline, 'Wind Advisory');
  assert.equal(alert.severity, 'severe');
  assert.deepEqual(alert.regions, ['los-angeles']);
  assert.equal(alert.areaSource, 'feed');
  assert.equal(alert.issued, new Date(NOW - 3_600_000).toISOString());
  assert.equal(alert.fetchedAt, new Date(NOW).toISOString());
  assert.equal(alert.freshness, 'live');
  for (const missing of ['id', 'source', 'agency', 'headline'])
    assert.equal(createAlert({ ...base, [missing]: '  ' }), null, missing);
  assert.equal(createAlert({ ...base, kind: 'volcano' }), null);
  assert.equal(createAlert(null), null);
  const odd = createAlert({
    ...base,
    url: 'javascript:alert(1)',
    area: { type: 'LineString', coordinates: [] },
    areaSource: 'zones',
    body: 'x'.repeat(5000),
  });
  assert.equal(odd.url, null);
  assert.equal(odd.area, null);
  assert.equal(odd.areaSource, null);
  assert.equal(odd.body.length, 1500);
  assert.equal(clampText('a  b', 10), 'a b');
  assert.equal(clampText('abcdef', 4), 'abc…');
  assert.equal(isoOrNull('not a date'), null);
});

test('geometry is validated, boxed and anchored', () => {
  assert.equal(
    validateAlertGeometry({ type: 'Point', coordinates: [200, 0] }),
    null,
  );
  assert.equal(
    validateAlertGeometry({
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 1],
        ],
      ],
    }),
    null,
  );
  assert.deepEqual(geometryBbox(base.area), [-118.4, 34.0, -118.2, 34.2]);
  const anchor = alertAnchor(base);
  assert.ok(
    Math.abs(anchor.lon + 118.3) < 1e-9 && Math.abs(anchor.lat - 34.1) < 1e-9,
  );
  assert.deepEqual(
    alertAnchor({ area: { type: 'Point', coordinates: [1, 2] } }),
    {
      lon: 1,
      lat: 2,
    },
  );
  assert.equal(alertAnchor({ area: null }), null);
  assert.equal(alertTouchesBbox(base, [-118.3, 34.1, -118, 34.5]), true);
  assert.equal(alertTouchesBbox(base, [-117, 34.1, -116, 34.5]), false);
});

test('currency, order, freshness and filters', () => {
  const alert = createAlert(base, { fetchedAt: NOW });
  assert.equal(alertIsCurrent(alert, NOW), true);
  assert.equal(alertIsCurrent({ ends: '2026-11-01T16:59:00Z' }, NOW), false);
  assert.equal(alertIsCurrent({ starts: '2026-11-03T00:00:00Z' }, NOW), false);
  const minor = createAlert({
    ...base,
    id: 'b',
    severity: 'minor',
    kind: 'road',
  });
  const newer = createAlert({ ...base, id: 'c', issued: NOW });
  assert.deepEqual(
    [minor, alert, newer].sort(compareAlerts).map((entry) => entry.id),
    ['c', 'nws:1', 'b'],
  );
  assert.equal(feedFreshness(NOW - 100_000, 60_000, NOW), 'live');
  assert.equal(feedFreshness(NOW - 130_000, 60_000, NOW), 'stale');
  assert.equal(feedFreshness(null, 60_000, NOW), 'stale');
  const bay = createAlert({ ...base, id: 'd', regions: ['sf-bay-area'] });
  const all = [alert, minor, newer, bay];
  assert.deepEqual(
    filterAlerts(all, { region: 'sf-bay-area' }).map((entry) => entry.id),
    ['d'],
  );
  assert.deepEqual(
    filterAlerts(all, { kinds: ['road'] }).map((entry) => entry.id),
    ['b'],
  );
  assert.deepEqual(
    filterAlerts(all, { minSeverity: 'moderate' }).map((entry) => entry.id),
    ['nws:1', 'c', 'd'],
  );
  assert.equal(filterAlerts(all).length, 4);
  assert.deepEqual(countBySeverity(all), {
    extreme: 0,
    severe: 3,
    moderate: 0,
    minor: 1,
    unknown: 0,
  });
  assert.ok(ALERT_KIND_IDS.includes('airport'));
});

test('analyst records are JSON-safe and carry the anchor', () => {
  const record = mapAlertAnalystRecord(
    createAlert(base, { fetchedAt: NOW }),
    3,
  );
  assert.equal(record.id, 'nws:1');
  assert.equal(record.severityRank, 3);
  assert.equal(record.regions, 'los-angeles');
  assert.ok(Math.abs(record.lat - 34.1) < 1e-9);
  assert.equal(record.issuedMs, NOW - 3_600_000);
  assert.equal(mapAlertAnalystRecord(null, 7).id, 'ALERT-0007');
  assert.doesNotThrow(() => JSON.stringify(record));
});
