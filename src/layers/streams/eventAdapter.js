import {
  STREAM_KIND_LABELS,
  STREAM_PLACEMENT_LABELS,
  streamPriority,
} from './model.js';

/**
 * Live streams on the event map (src/layers/events/adapters.js): one icon
 * of kind `stream` per row the streams layer knows, and a `stream` feed the
 * drawer turns into a player only when the icon is clicked. The adapter
 * hands over metadata alone; the drawer owns the embed, its creation and
 * its teardown.
 * @param {{layer: object, layerId?: string, id?: string}} options
 */
export function createStreamsEventAdapter({
  layer,
  layerId = 'streams',
  id = 'streams',
}) {
  return {
    id,
    kind: 'stream',
    layerId,
    getEvents({ limit }) {
      const rows = layer?.getRows?.() || [];
      return rows
        .slice(0, Number.isFinite(limit) ? limit : undefined)
        .map((row) => ({
          id: row.id,
          lat: row.lat,
          lon: row.lon,
          title: row.title,
          description: [
            STREAM_KIND_LABELS[row.kind] || STREAM_KIND_LABELS.link,
            STREAM_PLACEMENT_LABELS[row.placement] || null,
          ]
            .filter(Boolean)
            .join(' · '),
          source: row.owner || row.sourceLabel || null,
          time: row.time,
          priority: streamPriority(row),
          data: { stream: row },
        }));
    },
    feed(event) {
      const stream = event.data?.stream || layer?.getRow?.(event.id) || null;
      if (!stream) return null;
      return {
        type: 'stream',
        stream,
        owner: stream.owner || null,
        terms: stream.terms || null,
      };
    },
    subscribe(notify) {
      if (typeof layer?.subscribe !== 'function') return () => {};
      let first = true;
      return layer.subscribe(() => {
        // The first call is the subscription's own snapshot, not a change.
        if (first) {
          first = false;
          return;
        }
        notify();
      });
    },
  };
}
