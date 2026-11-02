import {
  CCTV_MAX_SOURCES_CEILING,
  DEFAULT_CCTV_MAX_SOURCES,
} from './constants.js';
import { haversineKm } from '../common/geo.js';

/**
 * Drop the cameras one pack publishes from the same poles as another.
 *
 * Each rule names the pack whose listing wins (`keep`), the pack whose
 * duplicates go (`drop`) and the distance under which two cameras count as
 * one pole (`withinM`). A dropped pack's `sources` and `available` shrink in
 * place; a rule whose packs are absent or empty changes nothing. Cameras are
 * bucketed on a grid of `withinM` cells so a 1,200-camera pack checks its
 * neighbours, not every pair.
 *
 * @param {Array<{name:string, sources:Array<object>, available?:number}>} packs
 * @param {Array<{keep:string, drop:string, withinM:number}>} rules
 * @returns {Array<{keep:string, drop:string, suppressed:number}>} What changed.
 */
export function suppressPackOverlaps(packs, rules) {
  const changes = [];
  for (const rule of Array.isArray(rules) ? rules : []) {
    const withinM = Number(rule?.withinM);
    const primary = packs.find((pack) => pack?.name === rule?.keep);
    const secondary = packs.find((pack) => pack?.name === rule?.drop);
    if (
      !(withinM > 0) ||
      !primary?.sources?.length ||
      !secondary?.sources?.length
    )
      continue;
    const cellDeg = withinM / 111_320;
    const cellOf = (lat, lon) =>
      `${Math.floor(lat / cellDeg)}:${Math.floor(lon / cellDeg)}`;
    const grid = new Map();
    for (const source of primary.sources) {
      const lat = Number(source?.lat);
      const lon = Number(source?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const key = cellOf(lat, lon);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push({ lat, lon });
    }
    const withinKm = withinM / 1000;
    const nearPrimary = (lat, lon) => {
      const row = Math.floor(lat / cellDeg);
      const col = Math.floor(lon / cellDeg);
      for (let dr = -1; dr <= 1; dr += 1) {
        for (let dc = -1; dc <= 1; dc += 1) {
          for (const point of grid.get(`${row + dr}:${col + dc}`) || []) {
            if (haversineKm(lat, lon, point.lat, point.lon) <= withinKm)
              return true;
          }
        }
      }
      return false;
    };
    const before = secondary.sources.length;
    secondary.sources = secondary.sources.filter((source) => {
      const lat = Number(source?.lat);
      const lon = Number(source?.lon);
      return (
        !Number.isFinite(lat) || !Number.isFinite(lon) || !nearPrimary(lat, lon)
      );
    });
    const suppressed = before - secondary.sources.length;
    if (Number.isFinite(secondary.available))
      secondary.available = Math.max(0, secondary.available - suppressed);
    if (suppressed > 0)
      changes.push({ keep: rule.keep, drop: rule.drop, suppressed });
  }
  return changes;
}

/**
 * Resolve the catalog-wide source cap from an env value.
 *
 * @param {string|number|undefined} raw - CCTV_MAX_SOURCES as configured.
 * @returns {number} Cap bounded to [8, CCTV_MAX_SOURCES_CEILING].
 */
export function resolveCatalogCap(raw) {
  const parsed = Number(raw || DEFAULT_CCTV_MAX_SOURCES);
  if (!Number.isFinite(parsed)) return DEFAULT_CCTV_MAX_SOURCES;
  return Math.max(8, Math.min(CCTV_MAX_SOURCES_CEILING, Math.floor(parsed)));
}

/**
 * Merge source packs under one cap without starving any of them.
 *
 * Every pack arrives already ordered by its own priority (nearest-to-anchor
 * first) and already trimmed to its own per-pack cap. When the packs together
 * exceed the catalog cap, the cap is filled ROUND-ROBIN — one camera from
 * each pack per turn, in each pack's own order — so a lowered
 * CCTV_MAX_SOURCES thins every region a little instead of deleting whichever
 * pack happened to be appended last. Duplicate ids resolve last-pack-wins so
 * file/env overrides keep replacing live records; the record is then counted
 * against the pack that won it.
 *
 * @param {Array<{name:string, sources:Array<object>}>} packs - Normalized
 *   packs in merge order (earlier packs lose duplicate ids to later ones).
 * @param {number} maxCount - Catalog cap.
 * @returns {{sources:Array<object>, packs:Array<{name:string, offered:number, kept:number}>}}
 */
export function allocateSourceCap(packs, maxCount) {
  const owner = new Map();
  for (const pack of packs) {
    for (const source of pack.sources) {
      if (!source?.id) continue;
      owner.set(source.id, { pack: pack.name, source });
    }
  }
  const lanes = packs.map((pack) => ({
    name: pack.name,
    // Only the record that WON its id (the last occurrence anywhere, so also
    // the last within this pack) takes a lane slot; earlier duplicates never
    // count against the cap.
    queue: pack.sources.filter(
      (source) => source?.id && owner.get(source.id)?.source === source,
    ),
    next: 0,
    kept: 0,
  }));
  const total = lanes.reduce((sum, lane) => sum + lane.queue.length, 0);
  const limit = Math.min(total, Math.max(0, Math.floor(maxCount)));

  const sources = [];
  if (limit >= total) {
    for (const lane of lanes) {
      sources.push(...lane.queue);
      lane.kept = lane.queue.length;
    }
  } else {
    while (sources.length < limit) {
      for (const lane of lanes) {
        if (sources.length >= limit) break;
        if (lane.next >= lane.queue.length) continue;
        sources.push(lane.queue[lane.next]);
        lane.next += 1;
        lane.kept += 1;
      }
    }
  }
  return {
    sources,
    packs: lanes.map((lane) => ({
      name: lane.name,
      offered: lane.queue.length,
      kept: lane.kept,
    })),
  };
}
