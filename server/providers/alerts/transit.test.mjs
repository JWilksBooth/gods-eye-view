import assert from 'node:assert/strict';
import test from 'node:test';
import { PbfWriter } from 'pbf';
import {
  decodeGtfsAlertFeed,
  gtfsAlertSeverity,
  normalizeGtfsAlertFeed,
  translatedText,
} from './gtfsrt.js';
import {
  TRANSIT_ALERT_FEEDS,
  createTransitFeedSources,
  transitAlert,
} from './transit.js';

const NOW = Date.parse('2026-11-01T17:00:00Z');
const seconds = (minutes) => Math.round((NOW + minutes * 60_000) / 1000);

function translated(pbf, tag, text, language = 'en') {
  pbf.writeMessage(
    tag,
    (value, writer) =>
      writer.writeMessage(
        1,
        (entry, inner) => {
          inner.writeStringField(1, entry.text);
          if (entry.language) inner.writeStringField(2, entry.language);
        },
        value,
      ),
    { text, language },
  );
}

/** A GTFS-Realtime FeedMessage with two alerts, in protobuf bytes. */
function feedBytes() {
  const pbf = new PbfWriter();
  pbf.writeMessage(
    1,
    (header, writer) => {
      writer.writeStringField(1, '2.0');
      writer.writeVarintField(2, 0);
      writer.writeVarintField(3, seconds(-1));
    },
    {},
  );
  const alerts = [
    {
      id: 'elevator-1',
      start: seconds(-60),
      end: seconds(120),
      effect: 11,
      header: 'Elevator out of service',
      body: 'Use the ramp at the north entrance.',
    },
    {
      id: 'single-track',
      start: seconds(-30),
      end: 0,
      effect: 3,
      level: 4,
      header: 'Single tracking between two stations',
      body: '',
      url: 'https://www.bart.gov/schedules/advisories',
    },
  ];
  for (const alert of alerts) {
    pbf.writeMessage(
      2,
      (value, entity) => {
        entity.writeStringField(1, value.id);
        entity.writeMessage(
          5,
          (data, writer) => {
            writer.writeMessage(
              1,
              (range, inner) => {
                inner.writeVarintField(1, range.start);
                if (range.end) inner.writeVarintField(2, range.end);
              },
              data,
            );
            writer.writeMessage(
              5,
              (selector, inner) => inner.writeStringField(1, 'BART'),
              {},
            );
            writer.writeVarintField(7, data.effect);
            if (data.url) translated(writer, 8, data.url);
            translated(writer, 10, data.header);
            if (data.body) translated(writer, 11, data.body);
            if (data.level) writer.writeVarintField(14, data.level);
          },
          value,
        );
      },
      alert,
    );
  }
  return pbf.finish();
}

test('protobuf alerts decode into the spec shape', () => {
  const feed = normalizeGtfsAlertFeed(decodeGtfsAlertFeed(feedBytes()));
  assert.equal(feed.malformed, false);
  assert.equal(feed.timestamp, seconds(-1) * 1000);
  assert.equal(feed.alerts.length, 2);
  const [elevator, track] = feed.alerts;
  assert.equal(elevator.headline, 'Elevator out of service');
  assert.equal(elevator.effect, 'ACCESSIBILITY_ISSUE');
  assert.equal(elevator.severity, 'minor');
  assert.deepEqual(elevator.activePeriods, [
    { start: seconds(-60) * 1000, end: seconds(120) * 1000 },
  ]);
  assert.deepEqual(elevator.informed, [
    { agencyId: 'BART', routeId: null, stopId: null },
  ]);
  assert.equal(track.severity, 'severe', 'SEVERE severity level wins');
  assert.equal(track.url, 'https://www.bart.gov/schedules/advisories');
  assert.equal(track.activePeriods[0].end, null);
});

test('JSON renderings in every spelling normalize alike', () => {
  const pascal = normalizeGtfsAlertFeed({
    Header: { Timestamp: seconds(0) },
    Entities: [
      {
        Id: 'muni-1',
        Alert: {
          ActivePeriods: [{ Start: seconds(-10), End: seconds(60) }],
          InformedEntities: [{ AgencyId: 'SF', RouteId: 'N' }],
          Effect: 'DETOUR',
          HeaderText: {
            Translations: [
              { Text: 'Desvío', Language: 'es' },
              { Text: 'Detour on the N line', Language: 'en' },
            ],
          },
        },
      },
      { Id: 'deleted', IsDeleted: true, Alert: { HeaderText: 'x' } },
      { Id: 'empty', Alert: { HeaderText: { Translations: [] } } },
    ],
  });
  assert.equal(pascal.alerts.length, 1);
  assert.equal(pascal.alerts[0].headline, 'Detour on the N line');
  assert.equal(pascal.alerts[0].severity, 'moderate');
  assert.equal(pascal.alerts[0].informed[0].routeId, 'N');
  const camel = normalizeGtfsAlertFeed({
    entity: [
      {
        id: 'c-1',
        alert: {
          activePeriod: [{ start: String(seconds(0)) }],
          headerText: { translation: [{ text: 'Camel case' }] },
          severityLevel: 'INFO',
        },
      },
    ],
  });
  assert.equal(camel.alerts[0].severity, 'minor');
  assert.equal(normalizeGtfsAlertFeed({ nope: [] }).malformed, true);
  assert.equal(translatedText('plain'), 'plain');
  assert.equal(gtfsAlertSeverity(null, 'NO_SERVICE'), 'severe');
  assert.equal(gtfsAlertSeverity(null, 'SOMETHING'), 'unknown');
});

test('transit alerts drop what is over or far ahead and name 511 operators', () => {
  const [bart, sf511] = TRANSIT_ALERT_FEEDS;
  const record = (overrides) => ({
    id: 'r',
    headline: 'Fixture',
    body: 'Body',
    url: '',
    severity: 'minor',
    effect: 'MODIFIED_SERVICE',
    activePeriods: [],
    informed: [],
    ...overrides,
  });
  const live = transitAlert(bart, record({}), { now: NOW });
  assert.equal(live.kind, 'transit');
  assert.equal(live.agency, 'BART');
  assert.deepEqual(live.regions, ['sf-bay-area']);
  assert.equal(live.area, null);
  assert.equal(live.body, 'Body · modified service');
  assert.equal(live.url, 'https://www.bart.gov/schedules/advisories');
  assert.equal(
    transitAlert(
      bart,
      record({ activePeriods: [{ start: null, end: NOW - 1 }] }),
      {
        now: NOW,
      },
    ),
    null,
  );
  assert.equal(
    transitAlert(
      bart,
      record({ activePeriods: [{ start: NOW + 2 * 86_400_000, end: null }] }),
      { now: NOW },
    ),
    null,
  );
  const regional = transitAlert(
    sf511,
    record({
      informed: [
        { agencyId: 'SF', routeId: null, stopId: null },
        { agencyId: 'SA', routeId: null, stopId: null },
        { agencyId: 'PE', routeId: null, stopId: null },
      ],
    }),
    { now: NOW },
  );
  assert.equal(regional.agency, 'San Francisco Muni · SMART · 511 operator PE');
  assert.deepEqual(regional.regions, ['sf-bay-area', 'sonoma-county']);
});

test('keyed feeds wait for their key and read it on every load', async () => {
  const env = {};
  const asked = [];
  const fetchImpl = async (url, init) => {
    asked.push({ url: String(url), auth: init.headers.Authorization ?? null });
    if (String(url).includes('api.bart.gov'))
      return new Response(feedBytes(), {
        headers: { 'content-type': 'application/octet-stream' },
      });
    if (String(url).includes('api.511.org'))
      return new Response(JSON.stringify({ Entities: [] }), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    return new Response(feedBytes(), {
      headers: { 'content-type': 'application/x-protobuf' },
    });
  };
  const sources = createTransitFeedSources({ fetchImpl, env, now: () => NOW });
  const byId = Object.fromEntries(sources.map((source) => [source.id, source]));
  assert.equal(byId.bart.keyMissing(), false);
  assert.equal(byId.sf511.keyMissing(), true);
  assert.equal(byId.rtc.keyMissing(), true);
  await assert.rejects(byId.sf511.load(), (error) => error.code === 'no_key');
  assert.equal(asked.length, 0, 'a keyed feed without its key is never asked');

  const bart = await byId.bart.load();
  assert.equal(bart.alerts.length, 2);
  assert.equal(bart.alerts[0].source, 'bart');

  env.BAY_AREA_511_API_KEY = 'fixture-token';
  env.SWIFTLY_API_KEY = 'fixture-swiftly';
  assert.equal(byId.sf511.keyMissing(), false);
  await byId.sf511.load();
  const regional = new URL(asked.at(-1).url);
  assert.equal(regional.host, 'api.511.org');
  assert.equal(regional.searchParams.get('api_key'), 'fixture-token');
  assert.equal(regional.searchParams.get('agency'), 'RG');
  const metro = await byId['lametro-rail'].load();
  assert.equal(asked.at(-1).auth, 'fixture-swiftly');
  assert.equal(
    asked.at(-1).url,
    'https://api.goswift.ly/real-time/lametro-rail/gtfs-rt-alerts',
  );
  assert.deepEqual(metro.alerts[0].regions, ['los-angeles']);
});
