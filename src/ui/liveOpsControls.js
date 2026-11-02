/**
 * The LIVE OPS panel body: one button per region, a status line, the feed
 * states of the incidents layer, and the region's headlines. The panel
 * chrome (collapse, rail layout, persistence) belongs to the application
 * shell; this class owns only the body's DOM, listeners and in-flight
 * headline request, and releases them in destroy().
 *
 * Actions, supplied by the shell:
 * - `selectRegion(region)`: fly to the region and turn its layers on;
 *   resolves false when navigation was refused (Cockpit owns the camera).
 * - `getHeadlines(regionId, { signal })`: the region's headlines.
 * - `readIncidentStats()`: the incidents layer's stats, for the feed line.
 * - `subscribeLayers(listener)`: data-manager change notifications; returns
 *   an unsubscribe function.
 */
import { LIVE_OPS_LAYERS, LIVE_OPS_REGIONS } from '../data/liveOpsRegions.js';
import { formatRelativeTime, msg, t } from '../i18n/index.js';

/**
 * Scope Live Incidents to a region and turn the console's layers on. Only
 * enabled state and the incidents region change: every other layer setting
 * keeps its stored choice, Street Traffic's road source and vehicles switch
 * included, so a console click never puts simulated vehicles back on a map
 * whose owner turned them off.
 * @param {object} manager - The data manager.
 * @param {{id: string}} region - A LIVE OPS region.
 * @returns {Promise<void>} Settles once every layer the manager has is on.
 */
export function enableLiveOpsRegionLayers(manager, region) {
  manager.setLayerParams?.(
    'incidents',
    { region: region.id },
    { origin: 'user' },
  );
  return Promise.all(
    LIVE_OPS_LAYERS.filter((id) => manager.layers?.has(id)).map((id) =>
      manager.setEnabled(id, true, { origin: 'user' }),
    ),
  ).then(() => undefined);
}

const STATUS_KEYS = Object.freeze({
  idle: msg('Pick a region'),
  flying: msg('Flying to {region}…'),
  ready: msg('{region} · cameras, incidents and traffic on'),
  refused: msg('Leave Cockpit to switch regions'),
  error: msg('{region} · headlines unavailable'),
});

const setText = (node, value) => {
  if (node && node.textContent !== value) node.textContent = value;
};

/** The published time as "3 minutes ago", or null when unknown. */
function publishedAgo(article, nowMs) {
  const at = Date.parse(article?.publishedAt || '');
  if (!Number.isFinite(at)) return null;
  const minutes = Math.round((nowMs - at) / 60_000);
  if (minutes < 60) return formatRelativeTime(-Math.max(0, minutes), 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 48) return formatRelativeTime(-hours, 'hour');
  return formatRelativeTime(-Math.round(hours / 24), 'day');
}

/** The chip for one incident feed: its count when live, otherwise why not. */
function feedChipText(source) {
  const feed = source.label || source.id;
  const count = source.count ?? 0;
  if (source.ok)
    return {
      text: t('{feed} {count}', { feed, count }),
      title: t('{feed} · live incidents: {count}', { feed, count }),
    };
  const off = source.error === 'disabled';
  return {
    text: off ? t('{feed} off', { feed }) : t('{feed} unavailable', { feed }),
    title: off
      ? t('{feed} is turned off on this server', { feed })
      : t('{feed} is not answering', { feed }),
  };
}

function safeHref(url) {
  try {
    const parsed = new URL(String(url || ''));
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

export class LiveOpsControls {
  constructor({
    root,
    actions,
    regions = LIVE_OPS_REGIONS,
    document = root?.ownerDocument ?? globalThis.document,
    now = () => Date.now(),
  }) {
    this.root = root;
    this.actions = actions;
    this.regions = regions;
    this.document = document;
    this.now = now;
    this.destroyed = false;
    this.listeners = new AbortController();
    this._activeRegionId = null;
    this._headlineRequest = null;
    this._unsubscribeLayers = null;
    this._buttons = new Map();
    this._elements = {
      regions: root?.querySelector('#live-ops-regions') || null,
      status: root?.querySelector('#live-ops-status') || null,
      feeds: root?.querySelector('#live-ops-feeds') || null,
      headlines: root?.querySelector('#live-ops-headlines') || null,
    };
    this._renderButtons();
    this._setStatus('idle');
  }

  connect() {
    if (this.destroyed || this._unsubscribeLayers) return;
    this._unsubscribeLayers =
      this.actions.subscribeLayers?.(() => this._renderFeeds()) || null;
  }

  get activeRegionId() {
    return this._activeRegionId;
  }

  _renderButtons() {
    const host = this._elements.regions;
    if (!host) return;
    const nodes = [];
    for (const region of this.regions) {
      const button = this.document.createElement('button');
      button.type = 'button';
      button.className = 'gev-action-button scene-btn live-ops-region-btn';
      button.dataset.regionId = region.id;
      // Region names are public place names and stay as they are.
      button.textContent = region.name;
      button.title = t('Fly to {region} and turn on its live layers', {
        region: region.name,
      });
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => this.selectRegion(region.id), {
        signal: this.listeners.signal,
      });
      this._buttons.set(region.id, button);
      nodes.push(button);
    }
    host.replaceChildren(...nodes);
  }

  _setStatus(state, region = null) {
    const node = this._elements.status;
    if (!node) return;
    node.dataset.state = state;
    setText(node, t(STATUS_KEYS[state], { region: region?.name ?? '' }));
  }

  _syncPressed() {
    for (const [id, button] of this._buttons) {
      const pressed = id === this._activeRegionId ? 'true' : 'false';
      if (button.getAttribute('aria-pressed') !== pressed)
        button.setAttribute('aria-pressed', pressed);
    }
  }

  /** Fly to a region, enable its layers, and load its headlines. */
  async selectRegion(regionId) {
    if (this.destroyed) return false;
    const region = this.regions.find((entry) => entry.id === regionId);
    if (!region) return false;
    this._setStatus('flying', region);
    let result;
    try {
      result = await this.actions.selectRegion(region);
    } catch {
      result = false;
    }
    if (this.destroyed) return false;
    if (result === false) {
      this._setStatus('refused');
      return false;
    }
    this._activeRegionId = region.id;
    this._syncPressed();
    this._setStatus('ready', region);
    this._renderFeeds();
    this._loadHeadlines(region);
    return true;
  }

  /** Feed states, one chip per incident source the layer last heard from. */
  _renderFeeds() {
    const host = this._elements.feeds;
    if (!host || this.destroyed) return;
    const stats = this.actions.readIncidentStats?.() || null;
    const sources = Array.isArray(stats?.sources) ? stats.sources : [];
    if (!this._activeRegionId || !sources.length) {
      host.hidden = true;
      host.replaceChildren();
      return;
    }
    const chips = sources.map((source) => {
      const chip = this.document.createElement('span');
      chip.className = 'live-ops-feed';
      chip.dataset.ok = source.ok ? 'true' : 'false';
      const { text, title } = feedChipText(source);
      chip.textContent = text;
      chip.title = title;
      return chip;
    });
    host.hidden = false;
    host.replaceChildren(...chips);
  }

  _loadHeadlines(region) {
    this._headlineRequest?.abort();
    const controller = new AbortController();
    this._headlineRequest = controller;
    const host = this._elements.headlines;
    if (host) {
      const loading = this.document.createElement('li');
      loading.className = 'live-ops-empty';
      loading.textContent = t('Loading headlines…');
      host.replaceChildren(loading);
    }
    this.actions
      .getHeadlines(region.id, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted || this.destroyed) return;
        this._renderHeadlines(region, result);
      })
      .catch(() => {
        if (controller.signal.aborted || this.destroyed) return;
        this._renderHeadlines(region, null);
        this._setStatus('error', region);
      })
      .finally(() => {
        if (this._headlineRequest === controller) this._headlineRequest = null;
      });
  }

  _renderHeadlines(region, result) {
    const host = this._elements.headlines;
    if (!host) return;
    const articles = Array.isArray(result?.articles) ? result.articles : [];
    if (!articles.length) {
      const empty = this.document.createElement('li');
      empty.className = 'live-ops-empty';
      empty.textContent = result
        ? t('No recent headlines for {region}', { region: region.name })
        : t('Headlines unavailable for {region}', { region: region.name });
      host.replaceChildren(empty);
      return;
    }
    const nowMs = this.now();
    const items = [];
    for (const article of articles) {
      const href = safeHref(article.url);
      if (!href || !article.title) continue;
      const item = this.document.createElement('li');
      item.className = 'live-ops-headline';
      const link = this.document.createElement('a');
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = article.title;
      const meta = this.document.createElement('span');
      meta.className = 'live-ops-headline-meta';
      const ago = publishedAgo(article, nowMs);
      meta.textContent = [article.domain, ago].filter(Boolean).join(' · ');
      item.append(link, meta);
      items.push(item);
    }
    host.replaceChildren(...items);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.listeners.abort();
    this._headlineRequest?.abort();
    this._headlineRequest = null;
    this._unsubscribeLayers?.();
    this._unsubscribeLayers = null;
    this._buttons.clear();
  }
}
