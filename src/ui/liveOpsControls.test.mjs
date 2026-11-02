import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LiveOpsControls,
  enableLiveOpsRegionLayers,
} from './liveOpsControls.js';
import { LIVE_OPS_REGIONS } from '../data/liveOpsRegions.js';

test('a region click scopes incidents and turns the console layers on, and nothing else', async () => {
  const calls = [];
  const manager = {
    layers: new Map([
      ['cctv', {}],
      ['traffic', {}],
    ]),
    setLayerParams: (id, params, options) =>
      calls.push(['params', id, params, options.origin]),
    setEnabled: async (id, enabled, options) =>
      calls.push(['enabled', id, enabled, options.origin]),
  };
  await enableLiveOpsRegionLayers(manager, LIVE_OPS_REGIONS[0]);
  // Street Traffic keeps its stored road source and vehicles switch: the
  // console never sends it params, only turns it on.
  assert.deepEqual(calls, [
    ['params', 'incidents', { region: 'los-angeles' }, 'user'],
    ['enabled', 'cctv', true, 'user'],
    ['enabled', 'traffic', true, 'user'],
  ]);
});

/* A small DOM: just what the panel body touches. */
class FakeNode {
  constructor(document, tag) {
    this.ownerDocument = document;
    this.tagName = tag.toUpperCase();
    this.id = null;
    this.dataset = {};
    this.children = [];
    this.parent = null;
    this.listeners = new Map();
    this.attributes = new Map();
    this.textContent = '';
    this.title = '';
    this.hidden = false;
    this.className = '';
    this.href = '';
    this.target = '';
    this.rel = '';
    this.type = '';
  }
  setAttribute(key, value) {
    this.attributes.set(key, String(value));
  }
  getAttribute(key) {
    return this.attributes.get(key) ?? null;
  }
  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  *walk() {
    for (const child of this.children) {
      yield child;
      yield* child.walk();
    }
  }
  querySelector(selector) {
    const id = selector.slice(1);
    return [...this.walk()].find((node) => node.id === id) || null;
  }
  addEventListener(type, listener, { signal } = {}) {
    if (signal?.aborted) return;
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
    signal?.addEventListener('abort', () =>
      this.listeners.get(type)?.delete(listener),
    );
  }
  click() {
    for (const listener of [...(this.listeners.get('click') || [])])
      listener({ type: 'click', target: this });
  }
}

function panelDom() {
  const document = new FakeNode(null, '#document');
  document.ownerDocument = document;
  document.createElement = (tag) => new FakeNode(document, tag);
  const root = document.createElement('div');
  root.id = 'live-ops-panel';
  for (const [id, tag] of [
    ['live-ops-regions', 'div'],
    ['live-ops-status', 'div'],
    ['live-ops-feeds', 'div'],
    ['live-ops-headlines', 'ul'],
  ]) {
    const node = document.createElement(tag);
    node.id = id;
    root.appendChild(node);
  }
  return { document, root };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness({
  selectRegion = async () => true,
  getHeadlines = async () => ({ articles: [] }),
  stats = null,
} = {}) {
  const { document, root } = panelDom();
  const calls = { selected: [], headlines: [], unsubscribed: 0 };
  let notify = null;
  const controls = new LiveOpsControls({
    root,
    document,
    now: () => Date.parse('2026-11-01T12:00:00Z'),
    actions: {
      selectRegion: (region) => {
        calls.selected.push(region.id);
        return selectRegion(region);
      },
      getHeadlines: (regionId, options) => {
        calls.headlines.push(regionId);
        return getHeadlines(regionId, options);
      },
      readIncidentStats: () => stats,
      subscribeLayers: (listener) => {
        notify = listener;
        return () => {
          calls.unsubscribed += 1;
        };
      },
    },
  });
  controls.connect();
  const byId = (id) => root.querySelector(`#${id}`);
  return {
    controls,
    calls,
    byId,
    notify: () => notify?.(),
    buttons: () => byId('live-ops-regions').children,
  };
}

test('one button per registered region, in registry order', () => {
  const h = harness();
  assert.deepEqual(
    h.buttons().map((button) => button.textContent),
    LIVE_OPS_REGIONS.map((region) => region.name),
  );
  assert.deepEqual(
    h.buttons().map((button) => button.dataset.regionId),
    ['los-angeles', 'sonoma-county', 'sf-bay-area', 'las-vegas'],
  );
  assert.equal(h.byId('live-ops-status').textContent, 'Pick a region');
  assert.equal(h.byId('live-ops-feeds').hidden, false);
});

test('clicking a region flies, marks it pressed, lists feeds and loads headlines', async () => {
  const h = harness({
    stats: {
      sources: [
        { id: 'chp', label: 'CHP CAD', ok: true, count: 12 },
        { id: 'lafd-alerts', label: 'LAFD alerts', ok: false, error: 'HTTP 503' },
        { id: 'nvroads', label: 'Nevada 511 events', ok: false, error: 'disabled' },
      ],
    },
    getHeadlines: async () => ({
      articles: [
        {
          title: 'Brush fire closes the 405',
          url: 'https://example.com/a',
          domain: 'example.com',
          publishedAt: '2026-11-01T11:30:00Z',
        },
        { title: 'bad', url: 'javascript:alert(1)' },
      ],
    }),
  });
  h.buttons()[0].click();
  assert.equal(h.byId('live-ops-status').textContent, 'Flying to Los Angeles…');
  await tick();
  await tick();
  assert.deepEqual(h.calls.selected, ['los-angeles']);
  assert.equal(h.controls.activeRegionId, 'los-angeles');
  assert.equal(h.buttons()[0].getAttribute('aria-pressed'), 'true');
  assert.equal(h.buttons()[3].getAttribute('aria-pressed'), 'false');
  assert.equal(
    h.byId('live-ops-status').textContent,
    'Los Angeles · cameras, incidents and traffic on',
  );
  const feeds = h.byId('live-ops-feeds');
  assert.equal(feeds.hidden, false);
  assert.deepEqual(
    feeds.children.map((chip) => [chip.textContent, chip.dataset.ok]),
    [
      ['CHP CAD 12', 'true'],
      ['LAFD alerts unavailable', 'false'],
      ['Nevada 511 events off', 'false'],
    ],
  );
  assert.deepEqual(h.calls.headlines, ['los-angeles']);
  const items = h.byId('live-ops-headlines').children;
  assert.equal(items.length, 1);
  const [link, meta] = items[0].children;
  assert.equal(link.href, 'https://example.com/a');
  assert.equal(link.textContent, 'Brush fire closes the 405');
  assert.equal(link.rel, 'noopener noreferrer');
  assert.equal(meta.textContent, 'example.com · 30 minutes ago');
});

test('a refused flight (Cockpit) leaves no region active and asks no headlines', async () => {
  const h = harness({ selectRegion: async () => false });
  h.buttons()[1].click();
  await tick();
  await tick();
  assert.equal(h.controls.activeRegionId, null);
  assert.equal(h.byId('live-ops-status').textContent, 'Leave Cockpit to switch regions');
  assert.deepEqual(h.calls.headlines, []);
  assert.equal(h.buttons()[1].getAttribute('aria-pressed'), 'false');
});

test('headline failures and empty answers are reported, and layer changes refresh the feeds', async () => {
  let fail = true;
  const h = harness({
    getHeadlines: async () => {
      if (fail) throw new Error('offline');
      return { articles: [] };
    },
    stats: { sources: [{ id: 'chp', label: 'CHP CAD', ok: true, count: 1 }] },
  });
  h.buttons()[2].click();
  await tick();
  await tick();
  assert.equal(
    h.byId('live-ops-headlines').children[0].textContent,
    'Headlines unavailable for San Francisco Bay Area',
  );
  assert.equal(
    h.byId('live-ops-status').textContent,
    'San Francisco Bay Area · headlines unavailable',
  );
  fail = false;
  h.buttons()[2].click();
  await tick();
  await tick();
  assert.equal(
    h.byId('live-ops-headlines').children[0].textContent,
    'No recent headlines for San Francisco Bay Area',
  );
  h.notify();
  assert.equal(h.byId('live-ops-feeds').children[0].textContent, 'CHP CAD 1');
});

test('destroy releases the subscription and ignores late answers', async () => {
  let release;
  const h = harness({
    getHeadlines: () =>
      new Promise((resolve) => {
        release = () => resolve({ articles: [{ title: 'late', url: 'https://x.invalid/' }] });
      }),
  });
  h.buttons()[3].click();
  await tick();
  await tick();
  h.controls.destroy();
  assert.equal(h.calls.unsubscribed, 1);
  release();
  await tick();
  assert.equal(h.byId('live-ops-headlines').children[0].textContent, 'Loading headlines…');
  assert.equal(await h.controls.selectRegion('los-angeles'), false);
});
