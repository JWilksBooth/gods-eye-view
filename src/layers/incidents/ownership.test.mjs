import assert from 'node:assert/strict';
import test from 'node:test';
import { createIncidentsLayer } from './index.js';
import { normalizeIncidentSnapshot, incidentRecord } from './records.js';

const row = (id, extra = {}) => ({
  id: `chp:${id}`,
  source: 'chp',
  sourceLabel: 'CHP CAD',
  agency: 'CHP Los Angeles',
  type: 'traffic',
  typeDetail: 'Trfc Collision-No Inj',
  lat: 34.05,
  lon: -118.25,
  location: 'I-10 W / Alameda St',
  area: 'Central LA',
  time: 1_700_000_000_000,
  description: 'VEH BLOCKING #2',
  region: 'los-angeles',
  url: 'https://cad.chp.ca.gov/',
  ...extra,
});

function harness(snapshot, { pick = () => null, cardHit = () => null } = {}) {
  const sources = [];
  const overlay = { entries: new Map(), visible: new Map() };
  const clicks = { handler: null, destroyed: 0 };
  const opened = [];
  const viewer = {
    scene: { pick },
    dataSources: {
      add(value) {
        sources.push(value);
      },
      remove(value) {
        sources.splice(sources.indexOf(value), 1);
      },
    },
  };
  const requests = [];
  const layer = createIncidentsLayer({
    source: {
      getSnapshot: async () => (await snapshot()).rows,
      getSnapshotDetail: async (options) => {
        requests.push(options);
        return snapshot();
      },
    },
    overlayHost: {
      setEntries(sourceId, entries) {
        overlay.entries.set(sourceId, entries);
      },
      setVisible(sourceId, visible) {
        overlay.visible.set(sourceId, visible);
      },
      clearSource(sourceId) {
        overlay.entries.delete(sourceId);
      },
      hitTest: (x, y, options) => cardHit(x, y, options),
    },
    screenSpaceEventHandlerFactory: () => ({
      setInputAction(callback) {
        clicks.handler = callback;
      },
      destroy() {
        clicks.destroyed += 1;
        clicks.handler = null;
      },
    }),
    picking: {
      resolvePickId: (picked) => picked?.id ?? null,
      isOwnedByOtherLayer: (layerId, pickedId) =>
        String(pickedId).startsWith('other-layer:'),
    },
    pointer: { isPointerFree: () => true },
    openExternal: (url) => opened.push(url),
    now: () => 1_700_000_600_000,
  });
  layer.init(viewer);
  return { layer, viewer, sources, overlay, clicks, opened, requests };
}

test('a snapshot renders one point per incident and labels the newest', async () => {
  const h = harness(async () => ({
    rows: [row('1'), row('2', { type: 'fire', time: 1_700_000_100_000 })],
    sources: [{ id: 'chp', ok: true, count: 2 }],
    stale: false,
    fetchedAt: 1_700_000_500_000,
  }));
  h.layer.enable();
  assert.equal(await h.layer.update(), true);
  assert.equal(h.sources[0].entities.values.length, 2);
  const labels = h.overlay.entries.get('incidents');
  assert.equal(labels.length, 2);
  assert.equal(labels[0].id, 'incident:chp:2');
  assert.match(labels[0].title, /^Fire · I-10 W/);
  assert.deepEqual(h.layer.getStats(), {
    count: 2,
    lastUpdate: h.layer.getStats().lastUpdate,
    error: null,
    stale: false,
    partial: false,
    sources: [{ id: 'chp', ok: true, count: 2 }],
  });
  assert.equal(h.layer.getAnalystRecords()[0].id, 'chp:1');
  assert.equal(h.layer.getAnalystRecords()[0].timeMs, 1_700_000_000_000);
});

test('region and type params scope the request and the drawn rows', async () => {
  const h = harness(async () => ({
    rows: [row('1'), row('2', { type: 'fire' })],
    sources: [],
    stale: false,
    fetchedAt: null,
  }));
  h.layer.setParams({ region: 'los-angeles', type: 'fire' });
  h.layer.enable();
  await h.layer.update();
  assert.equal(h.requests[0].region, 'los-angeles');
  assert.deepEqual(
    h.layer.getRows().map((entry) => entry.id),
    ['chp:2'],
  );
  h.layer.setParams({ region: null, type: 'weather' });
  assert.deepEqual(h.layer.getParams(), { region: null, type: null });
});

test('a stale proxy snapshot dates the layer by its fetch and a failed source reads partial', async () => {
  let payload = {
    rows: [row('1')],
    sources: [
      { id: 'chp', ok: true, count: 1 },
      { id: 'datasf-police', ok: false, error: 'HTTP 503', count: 0 },
    ],
    stale: false,
    fetchedAt: 1_700_000_500_000,
  };
  const h = harness(async () => payload);
  h.layer.enable();
  await h.layer.update();
  assert.equal(h.layer.getStats().partial, true);
  payload = { ...payload, stale: true, sources: [] };
  await h.layer.update();
  assert.equal(h.layer.getStats().stale, true);
  assert.equal(h.layer.getStats().lastUpdate, 1_700_000_500_000);
  assert.equal(h.layer.getStats().partial, false);
});

test('clicking an incident publishes its card; the card opens the source; empty space clears it', async () => {
  let hit = null;
  const h = harness(
    async () => ({ rows: [row('1')], sources: [], stale: false, fetchedAt: null }),
    {
      pick: () => (hit ? { id: hit } : null),
      cardHit: (x, y, options) =>
        x === 7 && options.sourceId === 'incidents-selected'
          ? { entryId: 'incident-card:chp:1' }
          : null,
    },
  );
  h.layer.enable();
  await h.layer.update();
  hit = 'incident:chp:1';
  h.clicks.handler({ position: { x: 1, y: 1 } });
  const [card] = h.overlay.entries.get('incidents-selected');
  assert.equal(card.id, 'incident-card:chp:1');
  assert.equal(card.title, 'Traffic · CHP Los Angeles');
  assert.deepEqual(card.details.slice(0, 2), [
    'Trfc Collision-No Inj',
    'I-10 W / Alameda St',
  ]);
  assert.match(card.details.at(-2), /CHP CAD · reported 10 minutes ago/);
  assert.equal(card.interactive, true);
  h.clicks.handler({ position: { x: 7, y: 7 } });
  assert.deepEqual(h.opened, ['https://cad.chp.ca.gov/']);
  hit = 'other-layer:ship';
  h.clicks.handler({ position: { x: 1, y: 1 } });
  assert.equal(h.overlay.entries.get('incidents-selected').length, 1);
  hit = null;
  h.clicks.handler({ position: { x: 1, y: 1 } });
  assert.equal(h.overlay.entries.get('incidents-selected').length, 0);
  h.layer.disable();
  assert.equal(h.clicks.destroyed, 1);
  assert.equal(h.overlay.visible.get('incidents'), false);
});

test('a late refresh cannot publish after disable, and destroy releases the data source', async () => {
  let release;
  const h = harness(
    () =>
      new Promise((resolve) => {
        release = () =>
          resolve({ rows: [row('1')], sources: [], stale: false, fetchedAt: null });
      }),
  );
  h.layer.enable();
  const pending = h.layer.update();
  h.layer.disable();
  release();
  assert.equal(await pending, false);
  assert.equal(h.layer.getStats().count, 0);
  h.layer.destroy();
  assert.equal(h.sources.length, 0);
});

test('a malformed proxy answer is a reported error, not a blank layer', async () => {
  const h = harness(async () => {
    throw new Error('Malformed incident snapshot');
  });
  h.layer.enable();
  assert.equal(await h.layer.update(), false);
  assert.equal(h.layer.getStats().error, 'Malformed incident snapshot');
});

test('snapshot normalization drops malformed rows and duplicate ids, never the payload', () => {
  const snapshot = normalizeIncidentSnapshot({
    rows: [
      row('1'),
      row('1'),
      { id: 'chp:nopoint', source: 'chp' },
      { ...row('2'), type: 'weather', lat: '34.1', url: 'javascript:alert(1)' },
    ],
    sources: [{ id: 'chp', ok: 'yes', count: '2' }, null],
    stale: 'true',
    fetchedAt: 5,
  });
  assert.deepEqual(
    snapshot.rows.map((entry) => [entry.id, entry.type, entry.url]),
    [
      ['chp:1', 'traffic', 'https://cad.chp.ca.gov/'],
      ['chp:2', 'other', null],
    ],
  );
  assert.equal(snapshot.rows[1].lat, 34.1);
  assert.deepEqual(snapshot.sources, [
    {
      id: 'chp',
      label: null,
      ok: false,
      count: 0,
      fetchedAt: null,
      refreshMs: null,
      error: null,
    },
  ]);
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.fetchedAt, 5);
  assert.equal(normalizeIncidentSnapshot({ nope: true }), null);
  assert.equal(incidentRecord({ id: 'x', source: 's', lat: 91, lon: 0 }), null);
});
