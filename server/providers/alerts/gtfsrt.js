/**
 * GTFS-Realtime service alerts, decoded from the protobuf wire format with
 * `pbf` (the Transit layer's approach, src/data/gtfsRealtime.js) or read
 * from a feed's JSON rendering. Field numbers are the contract:
 *
 *   FeedMessage       1 header, 2 entity[]
 *   FeedHeader        1 gtfs_realtime_version, 2 incrementality, 3 timestamp
 *   FeedEntity        1 id, 2 is_deleted, 5 alert
 *   Alert             1 active_period[], 5 informed_entity[], 6 cause,
 *                     7 effect, 8 url, 10 header_text, 11 description_text,
 *                     14 severity_level
 *   TimeRange         1 start, 2 end
 *   EntitySelector    1 agency_id, 2 route_id, 3 route_type, 4 trip,
 *                     5 stop_id, 6 direction_id
 *   TranslatedString  1 translation[] { 1 text, 2 language }
 *
 * JSON renderings differ by producer (snake_case per the spec, camelCase, or
 * the PascalCase 511 SF Bay emits); `normalizeGtfsAlertFeed` reads all three.
 */
import { PbfReader } from 'pbf';

const MAX_ENTITIES = 5000;
const MAX_TEXT = 4000;

export const GTFS_ALERT_CAUSES = Object.freeze({
  1: 'UNKNOWN_CAUSE',
  2: 'OTHER_CAUSE',
  3: 'TECHNICAL_PROBLEM',
  4: 'STRIKE',
  5: 'DEMONSTRATION',
  6: 'ACCIDENT',
  7: 'HOLIDAY',
  8: 'WEATHER',
  9: 'MAINTENANCE',
  10: 'CONSTRUCTION',
  11: 'POLICE_ACTIVITY',
  12: 'MEDICAL_EMERGENCY',
});

export const GTFS_ALERT_EFFECTS = Object.freeze({
  1: 'NO_SERVICE',
  2: 'REDUCED_SERVICE',
  3: 'SIGNIFICANT_DELAYS',
  4: 'DETOUR',
  5: 'ADDITIONAL_SERVICE',
  6: 'MODIFIED_SERVICE',
  7: 'OTHER_EFFECT',
  8: 'UNKNOWN_EFFECT',
  9: 'STOP_MOVED',
  10: 'NO_EFFECT',
  11: 'ACCESSIBILITY_ISSUE',
});

export const GTFS_ALERT_SEVERITIES = Object.freeze({
  1: 'UNKNOWN_SEVERITY',
  2: 'INFO',
  3: 'WARNING',
  4: 'SEVERE',
});

const text = (pbf) => pbf.readString().slice(0, MAX_TEXT);

function readTranslation(tag, out, pbf) {
  if (tag === 1) out.text = text(pbf);
  else if (tag === 2) out.language = pbf.readString().slice(0, 16);
}
function readTranslatedString(tag, out, pbf) {
  if (tag === 1) out.translation.push(pbf.readMessage(readTranslation, {}));
}
function readTimeRange(tag, out, pbf) {
  if (tag === 1) out.start = pbf.readVarint();
  else if (tag === 2) out.end = pbf.readVarint();
}
function readTrip(tag, out, pbf) {
  if (tag === 1) out.trip_id = text(pbf);
  else if (tag === 5) out.route_id = text(pbf);
}
function readSelector(tag, out, pbf) {
  if (tag === 1) out.agency_id = text(pbf);
  else if (tag === 2) out.route_id = text(pbf);
  else if (tag === 3) out.route_type = pbf.readVarint();
  else if (tag === 4) out.trip = pbf.readMessage(readTrip, {});
  else if (tag === 5) out.stop_id = text(pbf);
  else if (tag === 6) out.direction_id = pbf.readVarint();
}
function readAlert(tag, out, pbf) {
  if (tag === 1) out.active_period.push(pbf.readMessage(readTimeRange, {}));
  else if (tag === 5) out.informed_entity.push(pbf.readMessage(readSelector, {}));
  else if (tag === 6) out.cause = GTFS_ALERT_CAUSES[pbf.readVarint()] || null;
  else if (tag === 7) out.effect = GTFS_ALERT_EFFECTS[pbf.readVarint()] || null;
  else if (tag === 8)
    out.url = pbf.readMessage(readTranslatedString, { translation: [] });
  else if (tag === 10)
    out.header_text = pbf.readMessage(readTranslatedString, { translation: [] });
  else if (tag === 11)
    out.description_text = pbf.readMessage(readTranslatedString, {
      translation: [],
    });
  else if (tag === 14)
    out.severity_level = GTFS_ALERT_SEVERITIES[pbf.readVarint()] || null;
}
function readEntity(tag, out, pbf) {
  if (tag === 1) out.id = text(pbf);
  else if (tag === 2) out.is_deleted = pbf.readBoolean();
  else if (tag === 5)
    out.alert = pbf.readMessage(readAlert, {
      active_period: [],
      informed_entity: [],
    });
}
function readHeader(tag, out, pbf) {
  if (tag === 1) out.gtfs_realtime_version = pbf.readString().slice(0, 16);
  else if (tag === 2) out.incrementality = pbf.readVarint();
  else if (tag === 3) out.timestamp = pbf.readVarint();
}
function readFeed(tag, out, pbf) {
  if (tag === 1) out.header = pbf.readMessage(readHeader, {});
  else if (tag === 2) {
    if (out.entity.length >= MAX_ENTITIES) {
      out.truncated = true;
      return;
    }
    out.entity.push(pbf.readMessage(readEntity, {}));
  }
}

/** Decode a FeedMessage's alerts into the spec's snake_case JSON shape. */
export function decodeGtfsAlertFeed(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return new PbfReader(view).readFields(readFeed, {
    header: {},
    entity: [],
    truncated: false,
  });
}

/** The first present property among several spellings. */
function pick(object, ...names) {
  if (!object || typeof object !== 'object') return undefined;
  for (const name of names) {
    if (object[name] !== undefined && object[name] !== null) return object[name];
  }
  return undefined;
}

/** The English (or first) text of a TranslatedString in any spelling. */
export function translatedText(value) {
  if (typeof value === 'string') return value.trim();
  const translations = pick(value, 'translation', 'translations', 'Translation', 'Translations');
  if (!Array.isArray(translations)) return '';
  const english = translations.find((entry) =>
    /^en\b/i.test(String(pick(entry, 'language', 'Language') || '')),
  );
  const chosen = english || translations[0];
  return String(pick(chosen, 'text', 'Text') || '').trim();
}

const toMs = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e11 ? n * 1000 : n;
};

const enumName = (value, table) => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return table[value] || null;
  const name = String(value).trim().toUpperCase();
  return Object.values(table).includes(name) ? name : name || null;
};

/** A severity id from a GTFS severity level, falling back on the effect. */
export function gtfsAlertSeverity(level, effect) {
  const name = String(level || '').toUpperCase();
  if (name === 'SEVERE') return 'severe';
  if (name === 'WARNING') return 'moderate';
  if (name === 'INFO') return 'minor';
  switch (String(effect || '').toUpperCase()) {
    case 'NO_SERVICE':
      return 'severe';
    case 'REDUCED_SERVICE':
    case 'SIGNIFICANT_DELAYS':
    case 'DETOUR':
    case 'STOP_MOVED':
      return 'moderate';
    case 'ADDITIONAL_SERVICE':
    case 'MODIFIED_SERVICE':
    case 'ACCESSIBILITY_ISSUE':
    case 'OTHER_EFFECT':
    case 'NO_EFFECT':
      return 'minor';
    default:
      return 'unknown';
  }
}

/**
 * Normalize a decoded or JSON FeedMessage into plain alert records:
 * `{ id, headline, body, url, severity, cause, effect, activePeriods,
 * informed }`. Deleted entities and entities without an alert are skipped.
 */
export function normalizeGtfsAlertFeed(feed) {
  const header = pick(feed, 'header', 'Header') || {};
  const timestamp = toMs(pick(header, 'timestamp', 'Timestamp'));
  const entities = pick(feed, 'entity', 'entities', 'Entity', 'Entities');
  const alerts = [];
  if (!Array.isArray(entities)) return { timestamp, alerts, malformed: true };
  for (const entity of entities.slice(0, MAX_ENTITIES)) {
    if (pick(entity, 'is_deleted', 'isDeleted', 'IsDeleted') === true) continue;
    const alert = pick(entity, 'alert', 'Alert');
    if (!alert || typeof alert !== 'object') continue;
    const id = String(pick(entity, 'id', 'Id') ?? '').trim();
    if (!id) continue;
    const headline = translatedText(
      pick(alert, 'header_text', 'headerText', 'HeaderText'),
    ).slice(0, MAX_TEXT);
    if (!headline) continue;
    const periods = pick(alert, 'active_period', 'activePeriod', 'ActivePeriods', 'ActivePeriod');
    const informed = pick(alert, 'informed_entity', 'informedEntity', 'InformedEntities', 'InformedEntity');
    const effect = enumName(pick(alert, 'effect', 'Effect'), GTFS_ALERT_EFFECTS);
    const level = enumName(
      pick(alert, 'severity_level', 'severityLevel', 'SeverityLevel'),
      GTFS_ALERT_SEVERITIES,
    );
    alerts.push({
      id,
      headline,
      body: translatedText(
        pick(alert, 'description_text', 'descriptionText', 'DescriptionText'),
      ).slice(0, MAX_TEXT),
      url: translatedText(pick(alert, 'url', 'Url')),
      severity: gtfsAlertSeverity(level, effect),
      severityLevel: level,
      cause: enumName(pick(alert, 'cause', 'Cause'), GTFS_ALERT_CAUSES),
      effect,
      activePeriods: (Array.isArray(periods) ? periods : []).map((range) => ({
        start: toMs(pick(range, 'start', 'Start')),
        end: toMs(pick(range, 'end', 'End')),
      })),
      informed: (Array.isArray(informed) ? informed : []).map((selector) => ({
        agencyId: String(pick(selector, 'agency_id', 'agencyId', 'AgencyId') ?? '').trim() || null,
        routeId: String(pick(selector, 'route_id', 'routeId', 'RouteId') ?? '').trim() || null,
        stopId: String(pick(selector, 'stop_id', 'stopId', 'StopId') ?? '').trim() || null,
      })),
    });
  }
  return { timestamp, alerts, malformed: false };
}
