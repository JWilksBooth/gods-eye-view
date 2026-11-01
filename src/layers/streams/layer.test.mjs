import assert from 'node:assert/strict';
import test from 'node:test';
import { createStreamsLayer, STREAM_PICK_PREFIX } from './index.js';
import { createStreamsEventAdapter } from './eventAdapter.js';
import {
  normalizeStreamSnapshot,
  sortStreams,
  streamRecord,
} from './records.js';
import {
  mapStreamAnalystRecord,
  selectStreamOverlayCohort,
  streamAccent,
} from './model.js';
import { streamEmbed } from './embed.js';

const row = (id, extra = {}) => ({
  id: `registry:${id}`,
  source: 'registry',
  sourceLabel: 'Curated live cameras',
  title: 'Bellagio Conservatory',
  lat: 36.1129,
  lon: -115.1765,
  region: 'las-vegas',
  kind: 'youtube',
  embed: { type: 'youtube', videoId: 'KJuGU7v5oYw' },
  pageUrl: 'https://www.youtube.com/watch?v=KJuGU7v5oYw',
  poster: 'https://i.ytimg.com/vi/KJuGU7v5oYw/hqdefault.jpg',
  owner: 'EarthCam',
  terms: 'Public YouTube live stream',
  placement: 'exact',
  verifiedAt: '2026-10-31',
  time: null,
  description: null,
  tags: [],
  ...extra,
});

function harness(snapshot, { pick = () => null, cardHit = () => null } = {}) {
  const sources = [];
  const overlay = { entries: new Map(), visible: new Map() };
  const clicks = { handler: null, destroyed: 0 };
  const opened = [];
  const owners = new Map();
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
  const layer = createStreamsLayer({
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
      registerPickOwner: (layerId, predicate) => owners.set(layerId, predicate),
      unregisterPickOwner: (layerId) => owners.delete(layerId),
    },
    pointer: { isPointerFree: () => true },
    openStream: (stream) => {
      opened.push(stream.id);
      return true;
    },
    readToken: (name) => (name === '--event-stream' ? ' #00ffaa ' : ''),
  });
  layer.init(viewer);
  return { layer, viewer, sources, overlay, clicks, opened, owners, requests };
}

test('records normalize, default pages and posters, and reject what cannot play', () => {
  const youtube = streamRecord({
    id: 'a',
    source: 'registry',
    title: ' Pier 23 ',
    lat: 37.8018,
    lon: -122.3989,
    kind: 'youtube',
    videoId: 'PDKGik7Np88',
    verifiedAt: '2026-10-31T12:00:00Z',
  });
  assert.equal(youtube.id, 'registry:a');
  assert.equal(youtube.title, 'Pier 23');
  assert.deepEqual(youtube.embed, { type: 'youtube', videoId: 'PDKGik7Np88' });
  assert.equal(youtube.pageUrl, 'https://www.youtube.com/watch?v=PDKGik7Np88');
  assert.equal(
    youtube.poster,
    'https://i.ytimg.com/vi/PDKGik7Np88/hqdefault.jpg',
  );
  assert.equal(youtube.verifiedAt, '2026-10-31');
  assert.equal(youtube.placement, 'exact');
  const hls = streamRecord({
    id: 'b',
    source: 'registry',
    title: 'US-101',
    lat: 38.4,
    lon: -122.7,
    kind: 'hls',
    url: 'https://wzmedia.dot.ca.gov/D4/x.stream/playlist.m3u8',
    placement: 'somewhere',
  });
  assert.equal(hls.pageUrl, hls.embed.url);
  assert.equal(hls.placement, 'approximate');
  assert.equal(
    streamRecord({
      id: 'c',
      source: 'registry',
      title: 'x',
      lat: 1,
      lon: 2,
      kind: 'youtube',
      videoId: 'short',
    }),
    null,
  );
  assert.equal(
    streamRecord({
      id: 'd',
      source: 'registry',
      title: 'x',
      lat: 1,
      lon: 2,
      kind: 'hls',
      url: 'http://insecure.example/a.m3u8',
    }),
    null,
  );
  assert.equal(
    streamRecord({
      id: 'e',
      source: 'elsewhere',
      title: 'x',
      lat: 1,
      lon: 2,
      kind: 'link',
      url: 'https://example.com/',
    }),
    null,
  );
  // The drawer's embed helper reads the same shape.
  assert.equal(streamEmbed(youtube).kind, 'youtube');
  assert.equal(streamEmbed(hls).kind, 'hls');
});

test('snapshots drop malformed and duplicate rows and keep source states', () => {
  const snapshot = normalizeStreamSnapshot({
    rows: [
      row('1'),
      row('1'),
      {
        id: 'registry:bad',
        source: 'registry',
        title: 'no embed',
        lat: 1,
        lon: 2,
        kind: 'hls',
      },
      {
        id: 'scanner:x',
        title: 'Clark County',
        lat: 36.1,
        lon: -115.1,
        kind: 'link',
        embed: {
          type: 'link',
          url: 'https://www.broadcastify.com/listen/ctid/1745',
        },
      },
    ],
    sources: [
      {
        id: 'youtube',
        label: 'YouTube live discovery',
        ok: false,
        keyRequired: true,
        error: 'no_key',
      },
    ],
    stale: false,
    fetchedAt: 5,
    region: 'las-vegas',
  });
  assert.deepEqual(
    snapshot.rows.map((entry) => entry.id),
    ['registry:1', 'scanner:x'],
  );
  assert.equal(snapshot.rows[1].source, 'scanner');
  assert.equal(snapshot.sources[0].keyRequired, true);
  assert.equal(snapshot.region, 'las-vegas');
  assert.equal(normalizeStreamSnapshot({ error: true }), null);
  assert.deepEqual(
    sortStreams([
      row('z', { source: 'scanner', kind: 'link', title: 'A' }),
      row('y', { kind: 'hls', title: 'B' }),
      row('x', { title: 'C' }),
    ]).map((entry) => entry.id),
    ['registry:x', 'registry:y', 'registry:z'],
  );
});

test('the model reads theme tokens, ranks cohorts and maps analyst records', () => {
  assert.equal(
    streamAccent('youtube', (name) =>
      name === '--event-stream' ? '#123456' : '',
    ),
    '#123456',
  );
  assert.equal(streamAccent('link'), '#9aa4ad');
  const cohort = selectStreamOverlayCohort(
    [
      { id: 'a', priority: 1 },
      { id: 'b', priority: 3 },
      { id: 'c', priority: 3 },
    ],
    2,
  );
  assert.deepEqual(
    cohort.map((entry) => entry.id),
    ['b', 'c'],
  );
  assert.deepEqual(mapStreamAnalystRecord(row('1')), {
    id: 'registry:1',
    title: 'Bellagio Conservatory',
    kind: 'youtube',
    source: 'Curated live cameras',
    owner: 'EarthCam',
    region: 'las-vegas',
    placement: 'exact',
    lat: 36.1129,
    lon: -115.1765,
    pageUrl: 'https://www.youtube.com/watch?v=KJuGU7v5oYw',
    verifiedAt: '2026-10-31',
    timeMs: null,
  });
});

test('a snapshot renders one point per stream and labels the curated ones first', async () => {
  const h = harness(async () => ({
    rows: [
      row('1'),
      row('2', {
        id: 'scanner:2',
        source: 'scanner',
        kind: 'link',
        title: 'Clark County scanner feeds',
        embed: {
          type: 'link',
          url: 'https://www.broadcastify.com/listen/ctid/1745',
        },
      }),
    ],
    sources: [
      { id: 'registry', ok: true, count: 1 },
      {
        id: 'youtube',
        ok: false,
        keyRequired: true,
        error: 'no_key',
        count: 0,
      },
    ],
    stale: false,
    fetchedAt: 1_700_000_500_000,
  }));
  h.layer.enable();
  assert.equal(typeof h.owners.get('streams'), 'function');
  assert.equal(
    h.owners.get('streams')(`${STREAM_PICK_PREFIX}registry:1`),
    true,
  );
  assert.equal(h.owners.get('streams')('incident:x'), false);
  assert.equal(await h.layer.update(), true);
  assert.equal(h.sources[0].entities.values.length, 2);
  assert.equal(h.sources[0].show, true);
  const labels = h.overlay.entries.get('streams');
  assert.equal(labels.length, 2);
  assert.equal(labels[0].id, 'stream:registry:1');
  assert.equal(labels[0].accent, '#00ffaa');
  assert.equal(labels[1].accent, '#9aa4ad');
  const stats = h.layer.getStats();
  assert.equal(stats.count, 2);
  assert.equal(stats.partial, false, 'a missing key is not a partial outage');
  assert.equal(stats.stale, false);
  assert.equal(h.layer.getAnalystRecords()[0].id, 'registry:1');
  assert.equal(h.layer.getRowControls().legend[0].count, 1);
  assert.equal(
    h.layer.findByQuery('Bellagio Conservatory').pickId,
    'stream:registry:1',
  );
  assert.equal(h.layer.findByQuery('stream:scanner:2').streamKind, 'link');
  assert.equal(h.layer.findByQuery('nothing'), null);
});

test('a click selects a stream, and the card opens it through the application', async () => {
  let picked = null;
  let hit = null;
  const h = harness(
    async () => ({
      rows: [row('1')],
      sources: [],
      stale: false,
      fetchedAt: null,
    }),
    { pick: () => picked, cardHit: () => hit },
  );
  h.layer.enable();
  await h.layer.update();
  picked = { id: `${STREAM_PICK_PREFIX}registry:1` };
  h.clicks.handler({ position: { x: 10, y: 10 } });
  const card = h.overlay.entries.get('streams-selected')[0];
  assert.equal(card.id, 'stream-card:registry:1');
  assert.equal(card.interactive, true);
  assert.equal(card.title, 'Bellagio Conservatory');
  assert.ok(card.details.includes('YouTube live'));
  assert.ok(card.details.includes('Published by EarthCam'));
  assert.ok(card.details.includes('Las Vegas'));
  assert.ok(card.details.includes('Checked on 2026-10-31'));
  assert.equal(card.activate(), true);
  assert.deepEqual(h.opened, ['registry:1']);
  hit = { entryId: card.id };
  h.clicks.handler({ position: { x: 10, y: 10 } });
  assert.deepEqual(h.opened, ['registry:1', 'registry:1']);
  hit = null;
  picked = null;
  h.clicks.handler({ position: { x: 10, y: 10 } });
  assert.deepEqual(h.overlay.entries.get('streams-selected'), []);
  h.layer.disable();
  assert.equal(h.clicks.destroyed, 1);
  assert.equal(h.owners.has('streams'), false);
});

test('the event map takes over the icons while it is on', async () => {
  const h = harness(async () => ({
    rows: [row('1')],
    sources: [],
    stale: false,
    fetchedAt: null,
  }));
  let eventsOn = false;
  let activity = null;
  h.layer.attachDataManager({
    isEnabled: (id) => id === 'events' && eventsOn,
    subscribeActivity: (callback) => {
      activity = callback;
      return () => {
        activity = null;
      };
    },
  });
  h.layer.enable();
  await h.layer.update();
  assert.equal(h.sources[0].show, true);
  eventsOn = true;
  activity({ type: 'visibility-settled', layerId: 'events' });
  assert.equal(h.sources[0].show, false);
  assert.equal(h.overlay.visible.get('streams'), false);
  // Rows are still there for the event map's adapter.
  assert.equal(h.layer.getRows().length, 1);
  eventsOn = false;
  activity({ type: 'visibility-settled', layerId: 'events' });
  assert.equal(h.sources[0].show, true);
  h.layer.destroy(h.viewer);
  assert.equal(activity, null);
  assert.equal(h.sources.length, 0);
});

test('the event adapter publishes stream icons and a stream feed, and follows changes', async () => {
  const h = harness(async () => ({
    rows: [
      row('1'),
      row('2', {
        id: 'youtube:2',
        source: 'youtube',
        placement: 'region-centre',
        lat: 36.1699,
        lon: -115.1398,
      }),
    ],
    sources: [],
    stale: false,
    fetchedAt: null,
  }));
  const adapter = createStreamsEventAdapter({ layer: h.layer });
  assert.equal(adapter.id, 'streams');
  assert.equal(adapter.kind, 'stream');
  assert.equal(adapter.layerId, 'streams');
  let notified = 0;
  const unsubscribe = adapter.subscribe(() => {
    notified += 1;
  });
  assert.equal(notified, 0, 'the subscription snapshot is not a change');
  h.layer.enable();
  await h.layer.update();
  assert.equal(notified, 1);
  const events = adapter.getEvents({ limit: 10 });
  assert.equal(events.length, 2);
  assert.equal(events[0].id, 'registry:1');
  assert.equal(events[0].description, 'YouTube live');
  assert.equal(
    events[1].description,
    'YouTube live · Placed at the region centre',
  );
  assert.ok(
    events[0].priority > events[1].priority,
    'curated streams rank first',
  );
  const feed = adapter.feed(events[0]);
  assert.equal(feed.type, 'stream');
  assert.equal(feed.owner, 'EarthCam');
  assert.equal(feed.terms, 'Public YouTube live stream');
  assert.equal(
    streamEmbed(feed.stream).url,
    'https://www.youtube-nocookie.com/embed/KJuGU7v5oYw?autoplay=1&mute=1&playsinline=1&rel=0&modestbranding=1',
  );
  assert.equal(adapter.feed({ id: 'missing', data: null }), null);
  unsubscribe();
  await h.layer.update();
  assert.equal(notified, 1);
});

test('region and kind params scope the request and the drawn rows', async () => {
  const h = harness(async () => ({
    rows: [
      row('1'),
      row('2', {
        id: 'registry:2',
        kind: 'hls',
        embed: {
          type: 'hls',
          url: 'https://wzmedia.dot.ca.gov/D4/x.stream/playlist.m3u8',
        },
      }),
    ],
    sources: [],
    stale: false,
    fetchedAt: null,
  }));
  h.layer.setParams({ region: 'las-vegas', kind: 'hls' });
  h.layer.enable();
  await h.layer.update();
  assert.equal(h.requests[0].region, 'las-vegas');
  assert.equal(h.requests[0].kind, 'hls');
  assert.deepEqual(
    h.layer.getRows().map((entry) => entry.id),
    ['registry:2'],
  );
  assert.deepEqual(h.layer.getParams(), { region: 'las-vegas', kind: 'hls' });
  h.layer.setParams({ kind: 'nonsense' });
  assert.equal(h.layer.getParams().kind, null);
});

test('a failing source keeps the layer honest about its error', async () => {
  const h = harness(async () => {
    throw new Error('Live stream feed unavailable (HTTP 503)');
  });
  h.layer.enable();
  assert.equal(await h.layer.update(), false);
  assert.equal(
    h.layer.getStats().error,
    'Live stream feed unavailable (HTTP 503)',
  );
});
