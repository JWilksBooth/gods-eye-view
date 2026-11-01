import test from 'node:test';
import assert from 'node:assert/strict';
import {
  alertEventPosition,
  alertEventPriority,
  createAlertsEventAdapter,
} from './alerts.js';
import { assertEventAdapter } from '../adapters.js';
import { normalizeEvent, rankEvents } from '../model.js';
import { createAlert } from '../../alerts/model.js';
import { ALERT_REGION_IDS, alertRegion } from '../../alerts/regions.js';

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const iso = (offsetMinutes) =>
  new Date(NOW + offsetMinutes * 60_000).toISOString();

function alert(overrides = {}) {
  return createAlert(
    {
      id: 'nws:qa-1',
      source: 'nws',
      kind: 'weather',
      severity: 'severe',
      agency: 'NWS San Francisco',
      headline: 'Wind Advisory',
      body: 'Gusts to 50 mph along the coast.',
      area: { type: 'Point', coordinates: [-122.42, 37.77] },
      areaDescription: 'San Francisco Peninsula Coast',
      regions: ['sf-bay'],
      issued: iso(-30),
      ends: iso(600),
      url: 'https://www.weather.gov/mtr/',
      ...overrides,
    },
    { fetchedAt: NOW },
  );
}

const layerWith = (alerts) => ({ getAlerts: () => alerts });

test('the adapter is a valid registration and maps the layer alerts with headline, agency and severity', () => {
  const adapter = createAlertsEventAdapter({ layer: layerWith([alert()]) });
  assertEventAdapter(adapter);
  assert.equal(adapter.id, 'alerts');
  assert.equal(adapter.kind, 'alert');
  assert.equal(adapter.layerId, 'alerts');
  const [event] = adapter.getEvents({ limit: 10, center: null, now: NOW });
  assert.equal(event.id, 'nws:qa-1');
  assert.equal(event.title, 'Wind Advisory');
  assert.equal(event.description, 'NWS San Francisco · Severe');
  assert.equal(event.source, 'weather.gov');
  assert.equal(event.time, NOW - 30 * 60_000);
  assert.equal(event.lat, 37.77);
  assert.equal(event.lon, -122.42);
  assert.equal(event.priority, alertEventPriority('severe'));
  assert.equal(event.data.placement, 'area');
  assert.equal(event.data.url, 'https://www.weather.gov/mtr/');
  assert.ok(normalizeEvent(event, adapter), 'the event layer can place it');
});

test('severity orders the cohort, newest first within a band, and the cap cuts after sorting', () => {
  const alerts = [
    alert({ id: 'a:minor-new', severity: 'minor', issued: iso(-1) }),
    alert({ id: 'a:severe-old', severity: 'severe', issued: iso(-120) }),
    alert({ id: 'a:extreme', severity: 'extreme', issued: iso(-300) }),
    alert({ id: 'a:severe-new', severity: 'severe', issued: iso(-5) }),
  ];
  const adapter = createAlertsEventAdapter({ layer: layerWith(alerts) });
  assert.deepEqual(
    adapter.getEvents({ limit: 10 }).map((event) => event.id),
    ['a:extreme', 'a:severe-new', 'a:severe-old', 'a:minor-new'],
  );
  assert.deepEqual(
    adapter.getEvents({ limit: 2 }).map((event) => event.id),
    ['a:extreme', 'a:severe-new'],
  );
  assert.ok(alertEventPriority('extreme') > alertEventPriority('severe'));
  assert.ok(alertEventPriority('severe') > alertEventPriority('moderate'));
  assert.ok(alertEventPriority('moderate') > alertEventPriority('minor'));
  assert.equal(alertEventPriority('unknown'), 0);
  const ranked = rankEvents(
    adapter
      .getEvents({ limit: 10 })
      .map((event) => normalizeEvent(event, adapter)),
    { limit: 10 },
  );
  assert.equal(
    ranked[0].id,
    'a:extreme',
    'the event layer ranks extreme first',
  );
});

test('a polygon anchors at its centre and a shapeless bulletin at its region centre', () => {
  const polygon = alert({
    id: 'nws:poly',
    area: {
      type: 'Polygon',
      coordinates: [
        [
          [-122.5, 37.7],
          [-122.3, 37.7],
          [-122.3, 37.9],
          [-122.5, 37.9],
          [-122.5, 37.7],
        ],
      ],
    },
  });
  const anchored = alertEventPosition(polygon);
  assert.ok(
    Math.abs(anchored.lon + 122.4) < 1e-9 &&
      Math.abs(anchored.lat - 37.8) < 1e-9,
  );
  assert.equal(anchored.placement, 'area');
  const regionId = ALERT_REGION_IDS[0];
  const bulletin = alert({ id: 'bart:1', area: null, regions: [regionId] });
  const placed = alertEventPosition(bulletin);
  assert.deepEqual(placed, {
    ...alertRegion(regionId).anchor,
    placement: 'region',
  });
  assert.equal(alertEventPosition(alert({ area: null, regions: [] })), null);
  const adapter = createAlertsEventAdapter({
    layer: layerWith([
      alert({ id: 'nowhere', area: null, regions: [] }),
      bulletin,
    ]),
  });
  assert.deepEqual(
    adapter.getEvents({ limit: 10 }).map((event) => event.id),
    ['bart:1'],
    'an alert nobody can place is skipped',
  );
});

test('an empty or missing layer contributes nothing', () => {
  assert.deepEqual(
    createAlertsEventAdapter({ layer: null }).getEvents({ limit: 5 }),
    [],
  );
  assert.deepEqual(
    createAlertsEventAdapter({ layer: {} }).getEvents({ limit: 5 }),
    [],
  );
});

test('the feed reuses the card lines, translates the severity and offers the source page', () => {
  const opened = [];
  const adapter = createAlertsEventAdapter({
    layer: layerWith([alert()]),
    describe: (entry) => [
      entry.headline,
      `${entry.agency} · Severe`,
      '',
      entry.body,
    ],
    severityLabel: (severity) => `[${severity}]`,
    openExternal: (url) => opened.push(url),
  });
  const [event] = adapter.getEvents({ limit: 1 });
  assert.equal(event.description, 'NWS San Francisco · [severe]');
  const feed = adapter.feed(normalizeEvent(event, adapter));
  assert.equal(feed.type, 'detail');
  assert.equal(feed.nearestCameras, true);
  assert.deepEqual(feed.lines, [
    'Wind Advisory',
    'NWS San Francisco · Severe',
    'Gusts to 50 mph along the coast.',
  ]);
  assert.equal(feed.actions.length, 1);
  assert.equal(feed.actions[0].label, 'Open at source');
  feed.actions[0].run();
  assert.deepEqual(opened, ['https://www.weather.gov/mtr/']);
});

test('without a describer the feed falls back to severity and agency, and no URL means no action', () => {
  const adapter = createAlertsEventAdapter({
    layer: layerWith([alert({ url: null })]),
    openExternal: () => assert.fail('nothing to open'),
  });
  const [event] = adapter.getEvents({ limit: 1 });
  const feed = adapter.feed(normalizeEvent(event, adapter));
  assert.deepEqual(feed.lines, [
    { label: 'Severity', value: 'Severe' },
    { label: 'Agency', value: 'NWS San Francisco' },
  ]);
  assert.deepEqual(feed.actions, []);
});

test('a stale event still describes the alert it carried when the layer no longer has it', () => {
  const describe = (entry) => [entry.id];
  const adapter = createAlertsEventAdapter({
    layer: layerWith([alert()]),
    describe,
  });
  const [event] = adapter.getEvents({ limit: 1 });
  const normalized = normalizeEvent(event, adapter);
  const gone = createAlertsEventAdapter({ layer: layerWith([]), describe });
  assert.deepEqual(gone.feed(normalized).lines, ['nws:qa-1']);
});
