/**
 * The feeds the Alerts layer reads, with the provenance each alert carries
 * and the budget the proxy holds it to. `refreshMs` is the cache interval an
 * open tab sees; `budgetPerHour` is the most upstream loads the process
 * makes in any rolling hour, whatever the number of tabs. Keyed feeds name
 * the environment variable Provider Settings writes; without it they report
 * `key-required` and are never requested.
 *
 * Nixle agency feeds were considered and left out: Everbridge issues each
 * agency's RSS address privately, and its terms forbid automated copying and
 * republishing of alert content. Utility outage maps (PG&E, NV Energy) have
 * no documented public API. See DATA_SOURCES.md for the full table.
 *
 * `regions` are the LIVE OPS regions a feed can speak for, so a question
 * about one region names only the feeds that cover it.
 */
import {
  ALERT_REGION_IDS,
  regionsForState,
} from '../../../src/layers/alerts/regions.js';

const EVERY_REGION = ALERT_REGION_IDS;
const CALIFORNIA = Object.freeze(regionsForState('CA'));
const only = (...ids) => Object.freeze(ids);

export const ALERT_FEEDS = Object.freeze({
  nws: Object.freeze({
    id: 'nws',
    regions: EVERY_REGION,
    label: 'NWS alerts',
    home: 'https://www.weather.gov/alerts',
    licence: 'US Government work, public domain; User-Agent required',
    refreshMs: 120_000,
    staleMaxMs: 60 * 60_000,
    budgetPerHour: 60,
  }),
  calfire: Object.freeze({
    id: 'calfire',
    regions: CALIFORNIA,
    label: 'CAL FIRE incidents',
    home: 'https://www.fire.ca.gov/incidents',
    licence: 'California public incident information (no licence text)',
    refreshMs: 300_000,
    staleMaxMs: 6 * 60 * 60_000,
    budgetPerHour: 20,
  }),
  caltrans: Object.freeze({
    id: 'caltrans',
    regions: CALIFORNIA,
    label: 'Caltrans lane closures',
    home: 'https://lcswebreports.dot.ca.gov/',
    licence: 'Caltrans CWWP2 public data feed (no licence text)',
    refreshMs: 600_000,
    staleMaxMs: 2 * 60 * 60_000,
    budgetPerHour: 12,
  }),
  faa: Object.freeze({
    id: 'faa',
    regions: EVERY_REGION,
    label: 'FAA airport status',
    home: 'https://nasstatus.faa.gov/',
    licence: 'US Government work, public domain',
    refreshMs: 120_000,
    staleMaxMs: 30 * 60_000,
    budgetPerHour: 45,
  }),
  airnow: Object.freeze({
    id: 'airnow',
    regions: EVERY_REGION,
    label: 'AirNow air quality',
    home: 'https://www.airnow.gov/',
    licence: 'US EPA AirNow, public; preliminary data, attribution requested',
    refreshMs: 15 * 60_000,
    staleMaxMs: 3 * 60 * 60_000,
    budgetPerHour: 8,
    envVar: 'AIRNOW_API_KEY',
  }),
  bart: Object.freeze({
    id: 'bart',
    regions: only('sf-bay-area'),
    label: 'BART service advisories',
    home: 'https://www.bart.gov/schedules/advisories',
    licence: 'BART developer license agreement (attribution)',
    refreshMs: 120_000,
    staleMaxMs: 30 * 60_000,
    budgetPerHour: 40,
  }),
  sf511: Object.freeze({
    id: 'sf511',
    regions: only('sf-bay-area', 'sonoma-county'),
    label: '511 SF Bay transit alerts',
    home: 'https://511.org/alerts/transit',
    licence: '511 SF Bay open data terms (free token; 60 requests an hour)',
    refreshMs: 300_000,
    staleMaxMs: 60 * 60_000,
    budgetPerHour: 15,
    envVar: 'BAY_AREA_511_API_KEY',
  }),
  'lametro-bus': Object.freeze({
    id: 'lametro-bus',
    regions: only('los-angeles'),
    label: 'LA Metro bus alerts',
    home: 'https://alerts.metro.net/',
    licence: 'Swiftly real-time API terms (free key)',
    refreshMs: 180_000,
    staleMaxMs: 60 * 60_000,
    budgetPerHour: 25,
    envVar: 'SWIFTLY_API_KEY',
  }),
  'lametro-rail': Object.freeze({
    id: 'lametro-rail',
    regions: only('los-angeles'),
    label: 'LA Metro rail alerts',
    home: 'https://alerts.metro.net/',
    licence: 'Swiftly real-time API terms (free key)',
    refreshMs: 180_000,
    staleMaxMs: 60 * 60_000,
    budgetPerHour: 25,
    envVar: 'SWIFTLY_API_KEY',
  }),
  rtc: Object.freeze({
    id: 'rtc',
    regions: only('las-vegas'),
    label: 'RTC Southern Nevada alerts',
    home: 'https://www.rtcsnv.com/',
    licence: 'Swiftly real-time API terms (free key)',
    refreshMs: 180_000,
    staleMaxMs: 60 * 60_000,
    budgetPerHour: 25,
    envVar: 'SWIFTLY_API_KEY',
  }),
  caloes: Object.freeze({
    id: 'caloes',
    regions: CALIFORNIA,
    label: 'Cal OES news',
    home: 'https://news.caloes.ca.gov/',
    licence: 'California public information (no licence text)',
    refreshMs: 600_000,
    staleMaxMs: 24 * 60 * 60_000,
    budgetPerHour: 8,
  }),
  socoemergency: Object.freeze({
    id: 'socoemergency',
    regions: only('sonoma-county'),
    label: 'SoCoEmergency',
    home: 'https://socoemergency.org/',
    licence: 'County of Sonoma public emergency information (no licence text)',
    refreshMs: 900_000,
    staleMaxMs: 24 * 60 * 60_000,
    budgetPerHour: 6,
  }),
  lafd: Object.freeze({
    id: 'lafd',
    regions: only('los-angeles'),
    label: 'LAFD alerts',
    home: 'https://lafd.org/alerts',
    licence: 'City of Los Angeles public alerts (no licence text)',
    refreshMs: 600_000,
    staleMaxMs: 24 * 60 * 60_000,
    budgetPerHour: 8,
  }),
});

/** Feed ids in the order the status list shows them. */
export const ALERT_FEED_IDS = Object.freeze(Object.keys(ALERT_FEEDS));
