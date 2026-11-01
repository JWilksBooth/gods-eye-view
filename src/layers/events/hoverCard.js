import { formatRelativeTime, t } from '../../i18n/index.js';
import { describeFreshness, eventKindLabel, relativeAge } from './model.js';

const EDGE_PX = 12;
const OFFSET_PX = 16;

/**
 * The one hover card. A single element is created on first use and kept;
 * showing another event rewrites its text, moving the pointer over the
 * same event only moves it, and an empty-map pointer never touches the DOM.
 * @param {{documentRef?: Document, now?: () => number}} [options]
 */
export function createEventHoverCard({
  documentRef = globalThis.document,
  now = () => Date.now(),
} = {}) {
  let root = null;
  let fields = null;
  let currentKey = null;
  let hideTimer = 0;

  function ensure() {
    if (root) return root;
    root = documentRef.createElement('div');
    root.id = 'event-hover-card';
    root.className = 'event-hover-card';
    root.hidden = true;
    root.setAttribute('role', 'tooltip');
    root.setAttribute('aria-hidden', 'true');
    const make = (tag, className) => {
      const node = documentRef.createElement(tag);
      node.className = className;
      root.appendChild(node);
      return node;
    };
    fields = {
      kind: make('span', 'event-hover-kind'),
      title: make('strong', 'event-hover-title'),
      time: make('span', 'event-hover-time'),
      description: make('span', 'event-hover-description'),
      source: make('span', 'event-hover-source'),
    };
    documentRef.body.appendChild(root);
    return root;
  }

  function cancelHide() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = 0;
    }
  }

  /** Clamp the card near the pointer inside the viewport. */
  function place(position) {
    if (!root || !position) return;
    const view = documentRef.defaultView;
    const width = view?.innerWidth || 0;
    const height = view?.innerHeight || 0;
    const rect = { w: root.offsetWidth || 240, h: root.offsetHeight || 80 };
    let x = position.x + OFFSET_PX;
    let y = position.y + OFFSET_PX;
    if (width && x + rect.w + EDGE_PX > width) x = position.x - rect.w - OFFSET_PX;
    if (height && y + rect.h + EDGE_PX > height) y = position.y - rect.h - OFFSET_PX;
    x = Math.max(EDGE_PX, x);
    y = Math.max(EDGE_PX, y);
    root.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  function freshnessText(event) {
    const freshness = describeFreshness(event.time, now());
    if (freshness.state === 'unknown') return '';
    if (freshness.state === 'live') return t('live now');
    const { value, unit } = relativeAge(freshness.ageMs);
    const relative = formatRelativeTime(value, unit);
    return freshness.state === 'stale'
      ? t('{time} · stale', { time: relative })
      : relative;
  }

  function fill({ kind, title, time, description, source }) {
    fields.kind.textContent = kind;
    fields.title.textContent = title;
    fields.time.textContent = time;
    fields.time.hidden = !time;
    fields.description.textContent = description || '';
    fields.description.hidden = !description;
    fields.source.textContent = source || '';
    fields.source.hidden = !source;
  }

  function reveal(position) {
    cancelHide();
    if (root.hidden) {
      root.hidden = false;
      root.setAttribute('aria-hidden', 'false');
    }
    place(position);
  }

  /**
   * Show an event near the pointer.
   * @param {object} event Normalized event.
   * @param {{x: number, y: number}} position CSS pixels.
   */
  function show(event, position) {
    ensure();
    if (currentKey !== event.pickId) {
      currentKey = event.pickId;
      root.dataset.kind = event.kind;
      fill({
        kind: t(eventKindLabel(event.kind)),
        title: event.title,
        time: freshnessText(event),
        description: event.description,
        source: event.source,
      });
    }
    reveal(position);
  }

  /**
   * Show a cluster summary near the pointer.
   * @param {{count: number, kind: string, breakdown: Array<{kind: string, count: number}>}} summary
   * @param {{x: number, y: number}} position
   */
  function showCluster(summary, position) {
    ensure();
    const key = `cluster:${summary.breakdown.map((row) => `${row.kind}=${row.count}`).join(',')}`;
    if (currentKey !== key) {
      currentKey = key;
      root.dataset.kind = summary.kind;
      fill({
        kind: t('Cluster'),
        title: t('{count} events', { count: summary.count }),
        time: '',
        description: summary.breakdown
          .map((row) => `${row.count} × ${t(eventKindLabel(row.kind))}`)
          .join(' · '),
        source: t('Click to list them'),
      });
    }
    reveal(position);
  }

  /** Follow the pointer while the same event stays hovered. */
  function move(position) {
    if (!root || root.hidden) return;
    place(position);
  }

  function hide() {
    cancelHide();
    currentKey = null;
    if (!root || root.hidden) return;
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
  }

  /** Hide after a short linger so gaps between icons do not flicker. */
  function scheduleHide(delayMs) {
    if (!root || root.hidden || hideTimer) return;
    hideTimer = setTimeout(() => {
      hideTimer = 0;
      hide();
    }, Math.max(0, delayMs));
  }

  function destroy() {
    cancelHide();
    root?.remove();
    root = null;
    fields = null;
    currentKey = null;
  }

  return {
    show,
    showCluster,
    move,
    hide,
    scheduleHide,
    destroy,
    get element() {
      return root;
    },
    get visible() {
      return Boolean(root && !root.hidden);
    },
    get currentKey() {
      return currentKey;
    },
  };
}
