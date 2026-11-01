import { formatRelativeTime, msg, t } from '../i18n/index.js';
import { getEventAdapter } from '../layers/events/adapters.js';
import {
  describeFreshness,
  eventKindLabel,
  relativeAge,
} from '../layers/events/model.js';
import { streamEmbed } from '../layers/streams/embed.js';
import { attachHlsVideo } from '../layers/streams/playback.js';
import { createCctvVideoSurface } from './cctvVideo.js';

const SNAPSHOT_REFRESH_MS = 10_000;
const DRAWER_ID = 'event-feed-drawer';

/**
 * The right-side feed drawer: one non-modal `dialog[data-panel-surface]`
 * (docs/panel-surfaces.md) that shows the live content behind an event
 * icon. It owns at most one media element at a time: opening another event
 * or closing tears the current one down, and a camera's video is painted
 * from the CCTV layer's single decoder rather than a second stream.
 *
 * @param {object} options
 * @param {Document} [options.documentRef]
 * @param {object} options.layers `{ cctv, events }` layer modules (lazy readers allowed).
 * @param {object} [options.cctvSource] `{ getFrameUrl }` for camera snapshots.
 * @param {object} [options.dataManager] For enabling the CCTV layer on demand.
 * @param {(open: boolean) => void} [options.onOpenChange]
 */
export function createEventFeedDrawer({
  documentRef = globalThis.document,
  layers,
  cctvSource = null,
  dataManager = null,
  onOpenChange = () => {},
} = {}) {
  let dialog = null;
  let nodes = null;
  let current = null;
  /** @type {Array<() => void>} teardown of the open feed's media and timers */
  let teardown = [];
  let removeKeydown = null;
  let activatedCameraId = null;

  const layerOf = (name) =>
    typeof layers?.[name] === 'function' ? layers[name]() : layers?.[name];

  function ensure() {
    if (dialog) return dialog;
    dialog = documentRef.createElement('dialog');
    dialog.id = DRAWER_ID;
    dialog.className = 'event-feed-drawer';
    dialog.setAttribute('data-panel-surface', '');
    dialog.setAttribute('aria-label', t('Live feed'));
    const header = documentRef.createElement('header');
    header.className = 'event-feed-header';
    header.setAttribute('data-panel-header', '');
    const kind = documentRef.createElement('span');
    kind.className = 'event-feed-kind';
    const title = documentRef.createElement('h2');
    title.className = 'panel-title panel-surface-title event-feed-title';
    const close = documentRef.createElement('button');
    close.type = 'button';
    close.className = 'panel-surface-control event-feed-close';
    close.setAttribute('aria-label', t('Close live feed'));
    close.title = t('Close (Esc)');
    close.textContent = '×';
    close.addEventListener('click', () => closeDrawer('button'));
    header.append(kind, title, close);
    const meta = documentRef.createElement('p');
    meta.className = 'event-feed-meta';
    const body = documentRef.createElement('div');
    body.className = 'event-feed-body';
    body.setAttribute('data-panel-body', '');
    body.setAttribute('data-rail-scroller', '');
    dialog.append(header, meta, body);
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      closeDrawer('escape');
    });
    documentRef.body.appendChild(dialog);
    nodes = { header, kind, title, close, meta, body };
    return dialog;
  }

  function onKeydown(event) {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (!dialog?.open) return;
    event.preventDefault();
    closeDrawer('escape');
  }

  function tearDownMedia() {
    for (const dispose of teardown.splice(0)) {
      try {
        dispose();
      } catch (error) {
        console.warn('[EventFeed] teardown error:', error);
      }
    }
    if (activatedCameraId) {
      const cctv = layerOf('cctv');
      try {
        if (cctv?.getParams?.().selectedCameraId === activatedCameraId)
          cctv.deactivateActiveCamera?.();
      } catch {
        /* the layer may already be off */
      }
      activatedCameraId = null;
    }
  }

  function freshnessText(event) {
    const freshness = describeFreshness(event.time, Date.now());
    if (freshness.state === 'unknown') return '';
    if (freshness.state === 'live') return t('live now');
    const { value, unit } = relativeAge(freshness.ageMs);
    return formatRelativeTime(value, unit);
  }

  function element(tag, className, text) {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function note(text) {
    return element('p', 'event-feed-note', text);
  }

  function actionButton(label, run) {
    const button = element('button', 'panel-surface-control event-feed-action', label);
    button.type = 'button';
    button.addEventListener('click', () => {
      try {
        run();
      } catch (error) {
        console.warn('[EventFeed] action error:', error);
      }
    });
    return button;
  }

  function renderLines(container, lines) {
    if (!Array.isArray(lines) || !lines.length) return;
    const list = element('dl', 'event-feed-lines');
    for (const line of lines) {
      if (!line) continue;
      if (typeof line === 'string') {
        list.appendChild(element('dd', 'event-feed-line', line));
        continue;
      }
      list.appendChild(element('dt', 'event-feed-label', t(String(line.label ?? ''))));
      list.appendChild(element('dd', 'event-feed-value', String(line.value ?? '')));
    }
    container.appendChild(list);
  }

  function renderActions(container, actions) {
    if (!Array.isArray(actions) || !actions.length) return;
    const row = element('div', 'event-feed-actions');
    for (const action of actions) {
      if (!action || typeof action.run !== 'function') continue;
      row.appendChild(actionButton(t(String(action.label ?? '')), action.run));
    }
    container.appendChild(row);
  }

  function renderNearestCameras(container, event) {
    const events = layerOf('events');
    const rows = events?.nearestCameras?.({ lat: event.lat, lon: event.lon }) || [];
    const section = element('section', 'event-feed-nearby');
    section.appendChild(element('h3', 'event-feed-subtitle', t('Nearest cameras')));
    if (!rows.length) {
      section.appendChild(note(t('No cameras within range. Turn the Cameras layer on to list them.')));
      container.appendChild(section);
      return;
    }
    const list = element('ul', 'event-feed-list');
    for (const { event: camera, km } of rows) {
      const item = element('li');
      const button = actionButton(
        t('{name} · {distance} km', {
          name: camera.title,
          distance: km < 10 ? km.toFixed(1) : Math.round(km),
        }),
        () => openEvent(camera, { origin: 'nearby' }),
      );
      item.appendChild(button);
      list.appendChild(item);
    }
    section.appendChild(list);
    container.appendChild(section);
  }

  function renderCameraFeed(container, event, feed) {
    const cctv = layerOf('cctv');
    const camera = feed.camera;
    const frame = element('figure', 'event-feed-frame');
    const img = documentRef.createElement('img');
    img.className = 'event-feed-image';
    img.alt = t('Camera snapshot');
    img.decoding = 'async';
    frame.appendChild(img);
    const caption = element('figcaption', 'event-feed-caption');
    frame.appendChild(caption);
    container.appendChild(frame);

    const refresh = () => {
      if (!camera || typeof cctvSource?.getFrameUrl !== 'function') return;
      try {
        img.src = cctvSource.getFrameUrl(camera, SNAPSHOT_REFRESH_MS);
      } catch {
        /* a malformed camera has no frame */
      }
    };
    refresh();
    const timer = setInterval(refresh, SNAPSHOT_REFRESH_MS);
    teardown.push(() => {
      clearInterval(timer);
      img.removeAttribute('src');
    });

    const layerOn = dataManager?.isEnabled?.(feed.layerId) ?? Boolean(cctv);
    if (feed.isVideo && layerOn && typeof cctv?.selectCamera === 'function') {
      // One decoder: the CCTV layer's own, started by activating the camera
      // and painted here on a bounded second surface (640 px, 15 fps).
      const canvas = documentRef.createElement('canvas');
      canvas.className = 'event-feed-video';
      canvas.width = 640;
      canvas.height = 360;
      frame.insertBefore(canvas, caption);
      const previous = cctv.getParams?.().selectedCameraId || null;
      if (previous !== feed.cameraId && cctv.selectCamera(feed.cameraId))
        activatedCameraId = feed.cameraId;
      const surface = createCctvVideoSurface(canvas, () =>
        cctv.getActiveVideoElement?.(),
      );
      teardown.push(() => surface.stop());
      caption.textContent = t('Live video · bounded HLS through the camera proxy');
      frame.classList.add('event-feed-frame--video');
    } else {
      caption.textContent = feed.isVideo
        ? t('Snapshot · turn the Cameras layer on for live video')
        : t('Snapshot · refreshes every 10 s while open');
    }
    const actions = [];
    if (typeof cctv?.selectCamera === 'function' && layerOn) {
      actions.push({
        label: t('Fly to camera'),
        run: () => cctv.selectCamera(feed.cameraId, { focus: true }),
      });
    }
    renderActions(container, actions.map((a) => ({ label: a.label, run: a.run })));
    if (camera?.credit || camera?.provider)
      container.appendChild(note(camera.credit || camera.provider));
  }

  function renderStreamFeed(container, event, feed) {
    const embed = streamEmbed(feed.stream || feed);
    const frame = element('figure', 'event-feed-frame event-feed-frame--stream');
    container.appendChild(frame);
    if (!embed) {
      frame.appendChild(note(t('This stream cannot be shown here.')));
      return;
    }
    const caption = element('figcaption', 'event-feed-caption');
    if (embed.kind === 'youtube') {
      const iframe = documentRef.createElement('iframe');
      iframe.className = 'event-feed-player';
      iframe.src = embed.url;
      iframe.title = event.title;
      iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
      iframe.referrerPolicy = 'strict-origin-when-cross-origin';
      iframe.setAttribute('allowfullscreen', '');
      iframe.loading = 'eager';
      frame.appendChild(iframe);
      teardown.push(() => {
        iframe.src = 'about:blank';
        iframe.remove();
      });
      caption.textContent = t('YouTube live · starts muted');
    } else if (embed.kind === 'hls') {
      const video = documentRef.createElement('video');
      video.className = 'event-feed-player';
      video.muted = true;
      video.playsInline = true;
      video.controls = true;
      video.autoplay = true;
      if (embed.poster) video.poster = embed.poster;
      frame.appendChild(video);
      const playback = attachHlsVideo(video, embed.url, {
        onFailure: () => {
          caption.textContent = t('Stream unavailable right now');
        },
      });
      teardown.push(() => {
        playback.dispose();
        video.remove();
      });
      caption.textContent = t('HLS live · starts muted');
    } else if (embed.kind === 'mjpeg') {
      const img = documentRef.createElement('img');
      img.className = 'event-feed-player event-feed-image';
      img.alt = event.title;
      img.src = embed.url;
      frame.appendChild(img);
      teardown.push(() => {
        img.removeAttribute('src');
        img.remove();
      });
      caption.textContent = t('Motion JPEG live');
    } else {
      if (embed.poster) {
        const poster = documentRef.createElement('img');
        poster.className = 'event-feed-image';
        poster.alt = '';
        poster.src = embed.poster;
        frame.appendChild(poster);
        teardown.push(() => poster.removeAttribute('src'));
      }
      caption.textContent = t('Opens on the provider site');
    }
    frame.appendChild(caption);
    const actions = [];
    if (embed.link || embed.kind === 'link') {
      const link = documentRef.createElement('a');
      link.className = 'panel-surface-control event-feed-action';
      link.href = embed.link || embed.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = t('Open on provider site');
      const row = element('div', 'event-feed-actions');
      row.appendChild(link);
      container.appendChild(row);
    }
    renderActions(container, actions);
    const owner = feed.owner || feed.stream?.owner;
    const terms = feed.terms || feed.stream?.terms;
    if (owner) container.appendChild(note(t('Source: {owner}', { owner })));
    if (terms) container.appendChild(note(terms));
  }

  function renderDetailFeed(container, event, feed) {
    renderLines(container, feed?.lines);
    renderActions(container, feed?.actions);
    if (feed?.nearestCameras) renderNearestCameras(container, event);
  }

  function renderHeader(event) {
    nodes.kind.textContent = t(eventKindLabel(event.kind));
    nodes.kind.dataset.kind = event.kind;
    nodes.title.textContent = event.title;
    const parts = [event.source, freshnessText(event), event.description].filter(Boolean);
    nodes.meta.textContent = parts.join(' · ');
    nodes.meta.hidden = !parts.length;
    dialog.dataset.kind = event.kind;
  }

  function render(event) {
    const adapter = getEventAdapter(event.adapterId);
    let feed = null;
    try {
      feed = adapter?.feed?.(event) || null;
    } catch (error) {
      console.warn('[EventFeed] feed error:', error);
    }
    nodes.body.replaceChildren();
    renderHeader(event);
    const container = nodes.body;
    if (feed?.type === 'camera') renderCameraFeed(container, event, feed);
    else if (feed?.type === 'stream') renderStreamFeed(container, event, feed);
    else
      renderDetailFeed(container, event, {
        ...feed,
        lines: feed?.lines || [
          { label: msg('Latitude'), value: event.lat.toFixed(4) },
          { label: msg('Longitude'), value: event.lon.toFixed(4) },
        ],
      });
  }

  function reveal() {
    if (!dialog.open) dialog.show();
    if (!removeKeydown) {
      documentRef.addEventListener('keydown', onKeydown);
      removeKeydown = () => documentRef.removeEventListener('keydown', onKeydown);
    }
    nodes.close.focus?.({ preventScroll: true });
    onOpenChange(true);
    documentRef.dispatchEvent(
      new CustomEvent('gev:event-feed-opened', {
        detail: { pickId: current?.pickId || null },
      }),
    );
  }

  /**
   * Open the drawer on one event.
   * @param {object} event Normalized event from the events layer.
   */
  function openEvent(event, { origin = 'programmatic' } = {}) {
    if (!event) return false;
    ensure();
    tearDownMedia();
    current = event;
    dialog.dataset.origin = origin;
    render(event);
    reveal();
    return true;
  }

  /**
   * Open the drawer on a cluster: a list of its members, each opening its
   * own feed.
   * @param {object[]} events
   */
  function openCluster(events, { origin = 'click' } = {}) {
    if (!Array.isArray(events) || !events.length) return false;
    ensure();
    tearDownMedia();
    current = null;
    dialog.dataset.origin = origin;
    dialog.dataset.kind = 'cluster';
    nodes.kind.textContent = t('Cluster');
    nodes.kind.dataset.kind = 'cluster';
    nodes.title.textContent = t('{count} events', { count: events.length });
    nodes.meta.textContent = t('Pick one to open its feed');
    nodes.meta.hidden = false;
    nodes.body.replaceChildren();
    const list = element('ul', 'event-feed-list');
    for (const event of events.slice(0, 60)) {
      const item = element('li');
      const button = actionButton(
        `${t(eventKindLabel(event.kind))} · ${event.title}`,
        () => openEvent(event, { origin: 'cluster' }),
      );
      button.dataset.pickId = event.pickId;
      item.appendChild(button);
      list.appendChild(item);
    }
    nodes.body.appendChild(list);
    if (events.length > 60)
      nodes.body.appendChild(note(t('Zoom in to see the rest.')));
    reveal();
    return true;
  }

  function closeDrawer(reason = 'programmatic') {
    if (!dialog) return false;
    tearDownMedia();
    const wasOpen = dialog.open;
    if (wasOpen) dialog.close();
    removeKeydown?.();
    removeKeydown = null;
    current = null;
    if (wasOpen) {
      onOpenChange(false);
      documentRef.dispatchEvent(
        new CustomEvent('gev:event-feed-closed', { detail: { reason } }),
      );
    }
    return wasOpen;
  }

  function destroy() {
    closeDrawer('destroy');
    dialog?.remove();
    dialog = null;
    nodes = null;
  }

  return {
    open: openEvent,
    openCluster,
    close: closeDrawer,
    destroy,
    get isOpen() {
      return Boolean(dialog?.open);
    },
    get current() {
      return current;
    },
    get element() {
      return dialog;
    },
  };
}
