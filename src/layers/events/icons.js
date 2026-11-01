/**
 * @module layers/events/icons
 * @description Event icons as SVG data URIs coloured from the page's theme
 * tokens. Nothing here names a colour: every fill comes from a CSS custom
 * property (`--event-<kind>` in src/ui/styles/events.css, which the theme
 * derives from the foundation palette), read once per theme and again when
 * the style changes. Outside a document (unit tests) the neutral fallback
 * palette below stands in, so the SVG builders stay pure.
 */
import { EVENT_KINDS } from './policy.js';

/**
 * Fallback used only when no stylesheet answers (tests, a detached host).
 * The live app always reads `--event-<kind>` from the document.
 */
export const FALLBACK_EVENT_THEME = Object.freeze({
  kinds: Object.freeze({
    camera: '#00d4ff',
    stream: '#7cf5d2',
    fire: '#ff7a3d',
    quake: '#ffc857',
    aircraft: '#e8eaed',
    vessel: '#5cc8ff',
    incident: '#ff5c6e',
    alert: '#ffe066',
  }),
  glyph: '#0a0a0f',
  ring: '#e8eaed',
  outline: '#0a0a0f',
  text: '#0a0a0f',
});

/** Shapes with a tail sit on the ground; the rest are centred on a point. */
export const EVENT_ICON_ANCHORS = Object.freeze({
  camera: 'pin',
  stream: 'pin',
  fire: 'pin',
  quake: 'pin',
  aircraft: 'point',
  vessel: 'point',
  incident: 'pin',
  alert: 'pin',
});

const GLYPHS = Object.freeze({
  camera:
    '<rect x="18" y="23" width="21" height="16" rx="3"/><path d="M40 28l9-5v16l-9-5z"/>',
  stream:
    '<path d="M25 20l18 11-18 11z"/><path d="M44 18a14 14 0 0 1 0 26" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
  fire: '<path d="M32 15c2 8 9 11 9 19a9 9 0 0 1-18 0c0-4 2-7 4-9 0 3 1 5 3 5 2 0 2-5 2-15z"/>',
  quake:
    '<circle cx="32" cy="31" r="5"/><circle cx="32" cy="31" r="11" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="32" cy="31" r="17" fill="none" stroke="currentColor" stroke-width="2.5" stroke-dasharray="7 5"/>',
  aircraft:
    '<path d="M32 13l4 11 15 9v5l-15-4-1 10 5 3v3l-8-2-8 2v-3l5-3-1-10-15 4v-5l15-9z"/>',
  vessel:
    '<path d="M15 35h34l-7 11H22z"/><path d="M30 18h4v15h-4z"/><path d="M24 30h16v4H24z"/>',
  incident:
    '<path d="M32 15l17 30H15z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M30 26h4v9h-4z"/><path d="M30 38h4v4h-4z"/>',
  alert:
    '<path d="M32 15a3 3 0 0 1 3 3v1a10 10 0 0 1 7 10v6l4 5H18l4-5v-6a10 10 0 0 1 7-10v-1a3 3 0 0 1 3-3z"/><path d="M27 43h10a5 5 0 0 1-10 0z"/>',
});

function cssVar(style, name) {
  const value = style?.getPropertyValue?.(name);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Read the icon palette from the document's custom properties.
 * @param {{documentRef?: Document}} [options]
 * @returns {{kinds: Record<string, string>, glyph: string, ring: string, outline: string, text: string}}
 */
export function readEventTheme({ documentRef = globalThis.document } = {}) {
  const root = documentRef?.documentElement;
  const view = documentRef?.defaultView;
  const style =
    root && typeof view?.getComputedStyle === 'function'
      ? view.getComputedStyle(root)
      : null;
  const fallback = FALLBACK_EVENT_THEME;
  const kinds = {};
  for (const kind of EVENT_KINDS) {
    kinds[kind] =
      cssVar(style, `--event-${kind}`) ||
      cssVar(style, '--accent') ||
      fallback.kinds[kind];
  }
  return {
    kinds,
    glyph:
      cssVar(style, '--event-icon-glyph') ||
      cssVar(style, '--bg-dark') ||
      fallback.glyph,
    ring:
      cssVar(style, '--event-icon-ring') ||
      cssVar(style, '--text-primary') ||
      fallback.ring,
    outline:
      cssVar(style, '--event-icon-outline') ||
      cssVar(style, '--bg-dark') ||
      fallback.outline,
    text:
      cssVar(style, '--event-icon-text') ||
      cssVar(style, '--bg-dark') ||
      fallback.text,
  };
}

function escapeAttr(value) {
  return String(value).replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * One kind's icon: a coloured badge with a glyph, and a tail for ground
 * kinds. 64 units high so a 28 px billboard stays crisp on HiDPI screens.
 * @param {string} kind
 * @param {object} theme From {@link readEventTheme}.
 * @returns {string} SVG markup.
 */
export function eventIconSvg(kind, theme = FALLBACK_EVENT_THEME) {
  const fill = theme.kinds?.[kind] || FALLBACK_EVENT_THEME.kinds[kind];
  const glyph = GLYPHS[kind] || GLYPHS.incident;
  const pin = EVENT_ICON_ANCHORS[kind] === 'pin';
  const tail = pin
    ? `<path d="M24 50l8 13 8-13z" fill="${escapeAttr(fill)}" stroke="${escapeAttr(theme.outline)}" stroke-width="2" stroke-linejoin="round"/>`
    : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">` +
    `<circle cx="32" cy="31" r="24" fill="${escapeAttr(theme.outline)}" opacity="0.55"/>` +
    tail +
    `<circle cx="32" cy="31" r="21" fill="${escapeAttr(fill)}" stroke="${escapeAttr(theme.ring)}" stroke-width="2.5"/>` +
    `<g fill="${escapeAttr(theme.glyph)}" color="${escapeAttr(theme.glyph)}">${glyph}</g>` +
    `</svg>`
  );
}

/**
 * A cluster badge: the dominant kind's colour with the member count.
 * @param {number} count
 * @param {string} kind Dominant kind.
 * @param {object} theme
 * @returns {string} SVG markup.
 */
export function clusterIconSvg(count, kind, theme = FALLBACK_EVENT_THEME) {
  const fill = theme.kinds?.[kind] || FALLBACK_EVENT_THEME.kinds[kind];
  const label = count > 999 ? '999+' : String(Math.max(0, Math.floor(count)));
  const fontSize = label.length > 3 ? 20 : label.length > 2 ? 24 : 28;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72" width="72" height="72">` +
    `<circle cx="36" cy="36" r="34" fill="${escapeAttr(fill)}" opacity="0.28"/>` +
    `<circle cx="36" cy="36" r="27" fill="${escapeAttr(fill)}" stroke="${escapeAttr(theme.ring)}" stroke-width="2.5"/>` +
    `<text x="36" y="36" fill="${escapeAttr(theme.text)}" font-family="JetBrains Mono, SF Mono, monospace" font-weight="700" font-size="${fontSize}" text-anchor="middle" dominant-baseline="central">${label}</text>` +
    `</svg>`
  );
}

/** A data URI for inline SVG markup. */
export function svgDataUri(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * Memoized icon images for one theme. `setTheme` drops the cache so icons
 * rebuild in the new palette on the next request.
 * @param {object} theme
 */
export function createEventIconCache(theme = FALLBACK_EVENT_THEME) {
  let current = theme;
  let icons = new Map();
  let clusters = new Map();
  return {
    get theme() {
      return current;
    },
    setTheme(next) {
      current = next || FALLBACK_EVENT_THEME;
      icons = new Map();
      clusters = new Map();
    },
    icon(kind) {
      let uri = icons.get(kind);
      if (!uri) {
        uri = svgDataUri(eventIconSvg(kind, current));
        icons.set(kind, uri);
      }
      return uri;
    },
    cluster(count, kind) {
      const key = `${kind}:${Math.min(1000, Math.max(0, Math.floor(count)))}`;
      let uri = clusters.get(key);
      if (!uri) {
        uri = svgDataUri(clusterIconSvg(count, kind, current));
        clusters.set(key, uri);
      }
      return uri;
    },
  };
}
