/**
 * The curated registry of public 24/7 live cameras: one JSON file per LIVE
 * OPS region under `registry/`, each `{ region, notes, entries: [...] }`.
 *
 * An entry is `{ id, title, lat, lon, kind, videoId | url, pageUrl?,
 * poster?, owner, terms, placement?, verified_at, tags? }` and becomes one
 * normalized row through `streamRecord`. Every YouTube entry was checked
 * against the public oEmbed endpoint (200 means public and embeddable) on
 * its `verified_at`; every HLS playlist answered `#EXTM3U` that day. The
 * loader re-reads the files on each refresh so a registry edit shows
 * without a restart, and a malformed entry is skipped, never the file.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LIVE_OPS_REGIONS,
  liveOpsRegion,
} from '../../../src/data/liveOpsRegions.js';
import { streamRecord } from '../../../src/layers/streams/records.js';

export const REGISTRY_SOURCE = Object.freeze({
  id: 'registry',
  label: 'Curated live cameras',
  refreshMs: 10 * 60_000,
});

/** Where the shipped registry lives, relative to a source root. */
export const REGISTRY_DIRECTORY = 'server/providers/streams/registry';

const DEFAULT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

/**
 * Normalize one registry file's entries. The file's `region` must be a
 * LIVE OPS region; an entry outside that region's box is kept but flagged
 * through the warn callback, since a curated vantage can sit just outside.
 * @param {object} file Parsed JSON.
 * @param {{warn?: Function, name?: string}} [options]
 * @returns {object[]} Normalized rows.
 */
export function parseRegistryFile(file, { warn = () => {}, name = 'registry' } = {}) {
  const region = liveOpsRegion(file?.region);
  if (!region) {
    warn(`[streams] ${name}: unknown region ${file?.region}`);
    return [];
  }
  const entries = Array.isArray(file?.entries) ? file.entries : [];
  const rows = [];
  const seen = new Set();
  for (const entry of entries) {
    const row = streamRecord({
      id: entry?.id,
      source: REGISTRY_SOURCE.id,
      sourceLabel: REGISTRY_SOURCE.label,
      title: entry?.title,
      lat: entry?.lat,
      lon: entry?.lon,
      region: region.id,
      kind: entry?.kind,
      videoId: entry?.videoId ?? null,
      url: entry?.url ?? null,
      pageUrl: entry?.pageUrl ?? null,
      poster: entry?.poster ?? null,
      owner: entry?.owner ?? null,
      terms: entry?.terms ?? null,
      placement: entry?.placement ?? 'exact',
      verifiedAt: entry?.verified_at ?? entry?.verifiedAt ?? null,
      description: entry?.description ?? null,
      tags: entry?.tags ?? [],
    });
    if (!row) {
      warn(`[streams] ${name}: skipped malformed entry ${entry?.id ?? '?'}`);
      continue;
    }
    if (seen.has(row.id)) {
      warn(`[streams] ${name}: duplicate entry ${row.id}`);
      continue;
    }
    seen.add(row.id);
    rows.push(row);
  }
  return rows;
}

/**
 * Read every region file under the registry directory. A file that cannot
 * be read or parsed is reported and skipped; the others still load.
 * @param {{sourceRoot?: string, warn?: Function, readFile?: Function}} [options]
 * @returns {Promise<object[]>}
 */
export async function loadRegistryStreams({
  sourceRoot = DEFAULT_ROOT,
  warn = (...args) => console.warn(...args),
  readFile = (file) => fsp.readFile(file, 'utf8'),
} = {}) {
  const directory = path.join(sourceRoot, REGISTRY_DIRECTORY);
  const rows = [];
  for (const region of LIVE_OPS_REGIONS) {
    const file = path.join(directory, `${region.id}.json`);
    let parsed;
    try {
      parsed = JSON.parse(await readFile(file));
    } catch (error) {
      if (error?.code !== 'ENOENT')
        warn(`[streams] registry ${region.id}: ${error?.message || error}`);
      continue;
    }
    rows.push(...parseRegistryFile(parsed, { warn, name: `registry ${region.id}` }));
  }
  return rows;
}
