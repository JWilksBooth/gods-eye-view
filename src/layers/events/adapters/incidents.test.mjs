import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INCIDENT_EVENT_PRIORITY,
  createIncidentsEventAdapter,
} from './incidents.js';
import { assertEventAdapter } from '../adapters.js';
import { normalizeEvent, rankEvents } from '../model.js';

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);

function row(overrides = {}) {
  return {
    id: 'chp:1',
    source: 'chp',
    sourceLabel: 'CHP CAD',
    agency: 'CHP',
    type: 'traffic',
    typeDetail: 'Trfc Collision-No Inj',
    lat: 37.7749,
    lon: -122.4194,
    location: 'I-80 at Fremont St',
    area: 'San Francisco',
    time: NOW - 5 * 60_000,
    description: null,
    region: 'sf-bay',
    url: 'https://cad.chp.ca.gov/',
    ...overrides,
  };
}

function layerWith(rows) {
  return { getRows: () => rows };
}

test('the adapter is a valid registration and maps the layer rows newest first', () => {
  const older = row({
    id: 'chp:2',
    time: NOW - 60 * 60_000,
    typeDetail: null,
    location: 'US-101',
  });
  const adapter = createIncidentsEventAdapter({
    layer: layerWith([older, row()]),
  });
  assertEventAdapter(adapter);
  assert.equal(adapter.id, 'incidents');
  assert.equal(adapter.kind, 'incident');
  assert.equal(adapter.layerId, 'incidents');
  const events = adapter.getEvents({ limit: 10, center: null, now: NOW });
  assert.deepEqual(
    events.map((event) => event.id),
    ['chp:1', 'chp:2'],
  );
  assert.equal(events[0].title, 'Trfc Collision-No Inj');
  assert.equal(
    events[1].title,
    'US-101',
    'a row without agency wording names its place',
  );
  assert.equal(events[0].description, 'I-80 at Fremont St · San Francisco');
  assert.equal(events[0].source, 'CHP CAD');
  assert.equal(events[0].time, NOW - 5 * 60_000);
  assert.equal(events[0].priority, INCIDENT_EVENT_PRIORITY.traffic);
  assert.equal(events[0].data.incidentId, 'chp:1');
  assert.equal(events[0].data.url, 'https://cad.chp.ca.gov/');
  assert.ok(normalizeEvent(events[0], adapter), 'the event layer can place it');
});

test('the cap keeps the newest rows and fires outrank road events in the cohort', () => {
  const rows = [
    row({ id: 'chp:old', time: NOW - 3 * 60 * 60_000 }),
    row({
      id: 'calfire:1',
      type: 'fire',
      source: 'calfire',
      time: NOW - 2 * 60 * 60_000,
    }),
    row({ id: 'chp:new', time: NOW - 60_000 }),
  ];
  const adapter = createIncidentsEventAdapter({ layer: layerWith(rows) });
  const capped = adapter.getEvents({ limit: 2, center: null, now: NOW });
  assert.deepEqual(
    capped.map((event) => event.id),
    ['chp:new', 'calfire:1'],
    'two newest first',
  );
  const ranked = rankEvents(
    adapter
      .getEvents({ limit: 10, center: null, now: NOW })
      .map((event) => normalizeEvent(event, adapter)),
    { limit: 10 },
  );
  assert.equal(ranked[0].id, 'calfire:1', 'fire priority wins the cohort');
});

test('an empty or missing layer contributes nothing', () => {
  assert.deepEqual(
    createIncidentsEventAdapter({ layer: null }).getEvents({ limit: 5 }),
    [],
  );
  assert.deepEqual(
    createIncidentsEventAdapter({ layer: {} }).getEvents({ limit: 5 }),
    [],
  );
});

test('the feed reuses the card lines and offers the agency page', () => {
  const opened = [];
  const adapter = createIncidentsEventAdapter({
    layer: layerWith([row()]),
    describe: (incident) => [
      `Traffic · ${incident.agency}`,
      incident.location,
      '',
    ],
    openExternal: (url) => opened.push(url),
  });
  const [event] = adapter.getEvents({ limit: 1 });
  const feed = adapter.feed(normalizeEvent(event, adapter));
  assert.equal(feed.type, 'detail');
  assert.equal(feed.nearestCameras, true);
  assert.deepEqual(feed.lines, ['Traffic · CHP', 'I-80 at Fremont St']);
  assert.equal(feed.actions.length, 1);
  assert.equal(feed.actions[0].label, 'Open at source');
  feed.actions[0].run();
  assert.deepEqual(opened, ['https://cad.chp.ca.gov/']);
});

test('without a describer the feed falls back to type and agency, and no URL means no action', () => {
  const adapter = createIncidentsEventAdapter({
    layer: layerWith([row({ url: null })]),
    openExternal: () => assert.fail('nothing to open'),
  });
  const [event] = adapter.getEvents({ limit: 1 });
  const feed = adapter.feed(normalizeEvent(event, adapter));
  assert.deepEqual(feed.lines, [
    { label: 'Type', value: 'traffic' },
    { label: 'Agency', value: 'CHP' },
  ]);
  assert.deepEqual(feed.actions, []);
});

test('a stale event still describes the row it carried when the layer no longer has it', () => {
  const adapter = createIncidentsEventAdapter({
    layer: layerWith([row()]),
    describe: (incident) => [incident.id],
  });
  const [event] = adapter.getEvents({ limit: 1 });
  const normalized = normalizeEvent(event, adapter);
  adapter.feed(normalized);
  const gone = createIncidentsEventAdapter({
    layer: layerWith([]),
    describe: (incident) => [incident.id],
  });
  assert.deepEqual(gone.feed(normalized).lines, ['chp:1']);
});
