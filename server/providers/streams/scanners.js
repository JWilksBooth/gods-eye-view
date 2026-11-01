/**
 * Public-safety scanner directories for the LIVE OPS regions, as link-outs
 * only. Broadcastify's terms (section 9(d)) forbid relaying, re-streaming or
 * embedding live audio without a commercial licence and the embed widget was
 * retired in 2026; OpenMHz allows links to the site but not to audio or its
 * API. So each entry opens the county's feed page on broadcastify.com, where
 * the audio plays on Broadcastify's own terms, and nothing here is fetched.
 *
 * County ids are Broadcastify's own (`/listen/ctid/<id>`), read from the
 * California and Nevada state pages on 2026-10-31.
 */
import { streamRecord } from '../../../src/layers/streams/records.js';

export const SCANNER_SOURCE = Object.freeze({
  id: 'scanner',
  label: 'Scanner directories',
  refreshMs: 60 * 60_000,
});

const TERMS =
  'Broadcastify feed directory; audio plays on broadcastify.com only, since its terms forbid relaying, re-streaming or embedding live feeds';

const COUNTIES = Object.freeze([
  {
    id: 'broadcastify-los-angeles-county',
    region: 'los-angeles',
    title: 'Los Angeles County scanner feeds',
    ctid: 201,
    lat: 34.0537,
    lon: -118.2428,
  },
  {
    id: 'broadcastify-sonoma-county',
    region: 'sonoma-county',
    title: 'Sonoma County scanner feeds',
    ctid: 231,
    lat: 38.44,
    lon: -122.71,
  },
  {
    id: 'broadcastify-san-francisco-county',
    region: 'sf-bay-area',
    title: 'San Francisco scanner feeds',
    ctid: 220,
    lat: 37.7793,
    lon: -122.4193,
  },
  {
    id: 'broadcastify-alameda-county',
    region: 'sf-bay-area',
    title: 'Alameda County scanner feeds',
    ctid: 183,
    lat: 37.8044,
    lon: -122.2712,
  },
  {
    id: 'broadcastify-santa-clara-county',
    region: 'sf-bay-area',
    title: 'Santa Clara County scanner feeds',
    ctid: 225,
    lat: 37.3382,
    lon: -121.8863,
  },
  {
    id: 'broadcastify-marin-county',
    region: 'sf-bay-area',
    title: 'Marin County scanner feeds',
    ctid: 203,
    lat: 37.9735,
    lon: -122.5311,
  },
  {
    id: 'broadcastify-contra-costa-county',
    region: 'sf-bay-area',
    title: 'Contra Costa County scanner feeds',
    ctid: 189,
    lat: 38.0194,
    lon: -122.1341,
  },
  {
    id: 'broadcastify-clark-county',
    region: 'las-vegas',
    title: 'Clark County scanner feeds',
    ctid: 1745,
    lat: 36.1699,
    lon: -115.1398,
  },
]);

/** The scanner link-outs as normalized rows (nothing is fetched). */
export function scannerStreams() {
  return COUNTIES.map((county) =>
    streamRecord({
      id: county.id,
      source: SCANNER_SOURCE.id,
      sourceLabel: SCANNER_SOURCE.label,
      title: county.title,
      lat: county.lat,
      lon: county.lon,
      region: county.region,
      kind: 'link',
      url: `https://www.broadcastify.com/listen/ctid/${county.ctid}`,
      owner: 'Broadcastify',
      terms: TERMS,
      placement: 'approximate',
      verifiedAt: '2026-10-31',
      description:
        'Public-safety scanner audio from volunteer feeds; opens on Broadcastify',
      tags: ['scanner', 'audio'],
    }),
  ).filter(Boolean);
}
