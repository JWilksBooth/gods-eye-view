/**
 * The feeds the Alerts layer reads, with the provenance each alert carries
 * and the budget the proxy holds it to. `refreshMs` is the cache interval an
 * open tab sees; `budgetPerHour` is the most upstream requests the process
 * makes in any rolling hour, whatever the number of tabs. Keyed feeds name
 * the environment variable Provider Settings writes; without it they report
 * `key-required` and are never requested.
 *
 * Nixle agency feeds were considered and left out: Everbridge issues each
 * agency's RSS address privately, and its terms forbid automated copying and
 * republishing of alert content. Utility outage maps (PG&E, NV Energy) have
 * no documented public API. See DATA_SOURCES.md for the full table.
 */

export const ALERT_FEEDS = Object.freeze({
  nws: Object.freeze({
    id: 'nws',
    label: 'NWS alerts',
    home: 'https://www.weather.gov/documentation/services-web-api',
    licence: 'US Government work, public domain; User-Agent required',
    refreshMs: 120_000,
    staleMaxMs: 60 * 60_000,
    budgetPerHour: 90,
  }),
  calfire: Object.freeze({
    id: 'calfire',
    label: 'CAL FIRE incidents',
    home: 'https://www.fire.ca.gov/incidents',
    licence: 'California public record (fire.ca.gov conditions of use)',
    refreshMs: 300_000,
    staleMaxMs: 6 * 60 * 60_000,
    budgetPerHour: 30,
  }),
  caltrans: Object.freeze({
    id: 'caltrans',
    label: 'Caltrans lane closures',
    home: 'https://cwwp2.dot.ca.gov/',
    licence: 'Caltrans Commercial Wholesale Web Portal public feed',
    refreshMs: 300_000,
    staleMaxMs: 2 * 60 * 60_000,
    budgetPerHour: 40,
  }),
  faa: Object.freeze({
    id: 'faa',
    label: 'FAA airport status',
    home: 'https://nasstatus.faa.gov/',
    licence: 'US Government work, public domain',
    refreshMs: 120_000,
    staleMaxMs: 30 * 60_000,
    budgetPerHour: 45,
  }),
  bart: Object.freeze({
    id: 'bart',
    label: 'BART service advisories',
    home: 'https://www.bart.gov/schedules/developers/gtfs-realtime',
    licence: 'BART developer license (attribution)',
    refreshMs: 120_000,
    staleMaxMs: 30 * 60_000,
    budgetPerHour: 40,
  }),
  sf511: Object.freeze({
    id: 'sf511',
    label: '511 SF Bay service alerts',
    home: 'https://511.org/open-data/transit',
    licence: '511 SF Bay open data (free token; 60 requests/hour)',
    refreshMs: 300_000,
    staleMaxMs: 60 * 60_000,
    budgetPerHour: 20,
    envVar: 'BAY_AREA_511_API_KEY',
  }),
  'lametro-bus': Object.freeze({
    id: 'lametro-bus',
    label: 'LA Metro bus alerts',
    home: 'https://developer.metro.net/',
    licence: 'Swiftly real-time API (free key; goswift.ly/api-license)',
    refreshMs: 180_000,
    staleMaxMs: 60 * 60_000,
    budgetPerHour: 30,
    envVar: 'SWIFTLY_API_KEY',
  }),
  'lametro-rail': Object.freeze({
    id: 'lametro-rail',
    label: 'LA Metro rail alerts',
    home: 'https://developer.metro.net/',
    licence: 'Swiftly real-time API (free key; goswift.ly/api-license)',
    refreshMs: 180_000,
    staleMaxMs: 60 * 60_000,
    budgetPerHour: 30,
    envVar: 'SWIFTLY_API_KEY',
  }),
  rtc: Object.freeze({
    id: 'rtc',
    label: 'RTC Southern Nevada alerts',
    home: 'https://www.rtcsnv.com/ways-to-travel/transit-services/for-developers/',
    licence: 'Swiftly real-time API (free key; goswift.ly/api-license)',
    refreshMs: 180_000,
    staleMaxMs: 60 * 60_000,
    budgetPerHour: 30,
    envVar: 'SWIFTLY_API_KEY',
  }),
  caloes: Object.freeze({
    id: 'caloes',
    label: 'Cal OES news',
    home: 'https://news.caloes.ca.gov/',
    licence: 'California public record (caloes.ca.gov conditions of use)',
    refreshMs: 600_000,
    staleMaxMs: 24 * 60 * 60_000,
    budgetPerHour: 12,
  }),
  socoemergency: Object.freeze({
    id: 'socoemergency',
    label: 'SoCoEmergency',
    home: 'https://socoemergency.org/',
    licence: 'County of Sonoma public emergency information',
    refreshMs: 600_000,
    staleMaxMs: 24 * 60 * 60_000,
    budgetPerHour: 12,
  }),
  lafd: Object.freeze({
    id: 'lafd',
    label: 'LAFD alerts',
    home: 'https://www.lafd.org/alerts',
    licence: 'City of Los Angeles public emergency information',
    refreshMs: 600_000,
    staleMaxMs: 24 * 60 * 60_000,
    budgetPerHour: 12,
  }),
});

/** Feed ids in the order the status list shows them. */
export const ALERT_FEED_IDS = Object.freeze(Object.keys(ALERT_FEEDS));
