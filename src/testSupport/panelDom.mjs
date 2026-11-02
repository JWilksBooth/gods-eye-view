/**
 * A small DOM for panel controller tests under node:test: elements with the
 * properties the CAMERAS quick panel and the camera wall touch (classes,
 * datasets, attributes, children, listeners with abort signals, dialogs),
 * a document that creates them, and manual timers.
 */
export class FakeClassList {
  constructor() {
    this.set = new Set();
  }
  contains(name) {
    return this.set.has(name);
  }
  add(...names) {
    for (const name of names) this.set.add(name);
  }
  remove(...names) {
    for (const name of names) this.set.delete(name);
  }
  toggle(name, force) {
    const next = force === undefined ? !this.set.has(name) : Boolean(force);
    if (next) this.set.add(name);
    else this.set.delete(name);
    return next;
  }
}

export class FakeNode {
  constructor(document, tag) {
    this.ownerDocument = document;
    this.tagName = String(tag).toUpperCase();
    this.id = '';
    this.dataset = {};
    this.children = [];
    this.parent = null;
    this.listeners = new Map();
    this.attributes = new Map();
    this.classList = new FakeClassList();
    this.style = {
      properties: new Map(),
      setProperty: (name, value) => this.style.properties.set(name, value),
      removeProperty: (name) => this.style.properties.delete(name),
    };
    this.textContent = '';
    this.title = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.src = '';
    this.alt = '';
    this.tabIndex = 0;
    this.type = '';
    this.open = false;
    this.focused = 0;
    this.scrolledInto = 0;
  }
  get className() {
    return [...this.classList.set].join(' ');
  }
  set className(value) {
    this.classList.set = new Set(String(value).split(/\s+/).filter(Boolean));
  }
  setAttribute(key, value) {
    this.attributes.set(key, String(value));
    if (key === 'open') this.open = true;
  }
  getAttribute(key) {
    return this.attributes.get(key) ?? null;
  }
  removeAttribute(key) {
    this.attributes.delete(key);
    if (key === 'src') this.src = '';
    if (key === 'open') this.open = false;
  }
  hasAttribute(key) {
    return this.attributes.has(key);
  }
  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }
  insertBefore(node, before) {
    const at = this.children.indexOf(before);
    node.parent = this;
    if (at < 0) this.children.push(node);
    else this.children.splice(at, 0, node);
    return node;
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  contains(node) {
    for (let cursor = node; cursor; cursor = cursor.parent)
      if (cursor === this) return true;
    return false;
  }
  *walk() {
    for (const child of this.children) {
      yield child;
      yield* child.walk();
    }
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  querySelectorAll(selector) {
    const match = (node) => {
      if (selector.startsWith('#')) return node.id === selector.slice(1);
      if (selector.startsWith('.'))
        return node.classList.contains(selector.slice(1));
      if (selector.startsWith('[') && selector.endsWith(']')) {
        const [name, raw] = selector.slice(1, -1).split('=');
        if (raw === undefined)
          return node.hasAttribute(name) || name in node.dataset;
        const value = raw.replace(/^['"]|['"]$/g, '');
        return node.getAttribute(name) === value;
      }
      return node.tagName === selector.toUpperCase();
    };
    return [...this.walk()].filter(match);
  }
  closest(selector) {
    for (let cursor = this; cursor; cursor = cursor.parent) {
      if (
        cursor.querySelectorAll &&
        cursor.parent &&
        [cursor].some(() => {
          const list = cursor.parent
            ? cursor.parent.querySelectorAll(selector)
            : [];
          return list.includes(cursor);
        })
      )
        return cursor;
    }
    return null;
  }
  addEventListener(type, listener, options = {}) {
    const { signal } = typeof options === 'object' && options ? options : {};
    if (signal?.aborted) return;
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
    signal?.addEventListener('abort', () =>
      this.listeners.get(type)?.delete(listener),
    );
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }
  /** Dispatch to this node, then bubble to ancestors (no capture phase model: capture listeners on ancestors run first). */
  dispatch(type, init = {}) {
    const event = {
      type,
      target: this,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.propagationStopped = true;
      },
      ...init,
    };
    const path = [];
    for (let cursor = this; cursor; cursor = cursor.parent) path.push(cursor);
    for (const node of path) {
      for (const listener of [...(node.listeners.get(type) || [])]) {
        listener(event);
      }
      if (event.propagationStopped) break;
    }
    return event;
  }
  click() {
    return this.dispatch('click', { detail: 1 });
  }
  focus() {
    this.focused += 1;
    this.ownerDocument.activeElement = this;
  }
  blur() {
    if (this.ownerDocument.activeElement === this)
      this.ownerDocument.activeElement = null;
  }
  scrollIntoView() {
    this.scrolledInto += 1;
  }
  getClientRects() {
    return [{}];
  }
  matches() {
    return false;
  }
  showModal() {
    this.open = true;
  }
  show() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
}

export function createFakeDocument() {
  const document = new FakeNode(null, '#document');
  document.ownerDocument = document;
  document.hidden = false;
  document.activeElement = null;
  document.createElement = (tag) => new FakeNode(document, tag);
  document.body = document.createElement('body');
  document.appendChild(document.body);
  document.getElementById = (id) => document.querySelector(`#${id}`);
  return document;
}

/** Deterministic timers: `advance(ms)` runs what is due, in order. */
export function createFakeTimers(start = 1_000_000) {
  let now = start;
  let nextId = 1;
  const pending = new Map();
  const schedule = (fn, ms, repeat) => {
    const id = nextId++;
    pending.set(id, {
      fn,
      at: now + Math.max(0, Number(ms) || 0),
      every: repeat ? Math.max(1, Number(ms) || 1) : 0,
    });
    return id;
  };
  return {
    now: () => now,
    setTimeout: (fn, ms) => schedule(fn, ms, false),
    setInterval: (fn, ms) => schedule(fn, ms, true),
    clearTimeout: (id) => pending.delete(id),
    clearInterval: (id) => pending.delete(id),
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, entry]) => entry.at <= until)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
        if (!due.length) break;
        const [id, entry] = due[0];
        now = entry.at;
        if (entry.every) entry.at = now + entry.every;
        else pending.delete(id);
        entry.fn();
      }
      now = until;
    },
    get count() {
      return pending.size;
    },
  };
}
