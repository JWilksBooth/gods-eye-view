/**
 * Helpers the incident sources share: a bounded upstream read, Pacific
 * local-time conversion for feeds that publish no zone, and type
 * classification from an agency's free-text incident type.
 */
import {
  readResponseJsonCapped,
  readResponseTextCapped,
} from '../common/http.js';
import { regionForPoint } from '../../../src/data/liveOpsRegions.js';

export const INCIDENT_USER_AGENT = 'gods-eye-view-incidents/1.0';
export const INCIDENT_FETCH_TIMEOUT_MS = 15_000;
export const INCIDENT_MAX_RESPONSE_BYTES = 6 * 1024 * 1024;

/**
 * One bounded upstream read: fixed deadline over headers and body, no
 * redirects unless the source says so, byte cap, and the body released on
 * every path that will not read it.
 */
export async function fetchIncidentUpstream(
  url,
  {
    fetchImpl = (...args) => globalThis.fetch(...args),
    headers = {},
    timeoutMs = INCIDENT_FETCH_TIMEOUT_MS,
    maxBytes = INCIDENT_MAX_RESPONSE_BYTES,
    redirect = 'error',
    json = true,
    signal = null,
  } = {},
) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': INCIDENT_USER_AGENT, ...headers },
    redirect,
    signal: combined,
  });
  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      /* no-op */
    }
    throw Object.assign(new Error(`HTTP ${response.status}`), {
      status: response.status,
    });
  }
  return json
    ? readResponseJsonCapped(response, maxBytes, combined)
    : readResponseTextCapped(response, maxBytes, combined);
}

const PACIFIC = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hour12: false,
  timeZoneName: 'shortOffset',
});

/**
 * Epoch milliseconds for a wall-clock time in America/Los_Angeles. The
 * offset is read from Intl for that instant, so daylight saving is right
 * on both sides of a change (the ambiguous repeated hour resolves to the
 * first, daylight, reading).
 */
export function pacificToUtcMs({ year, month, day, hour = 0, minute = 0 }) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  if (!Number.isFinite(guess)) return null;
  const offsetAt = (ms) => {
    const name = PACIFIC.formatToParts(new Date(ms)).find(
      (part) => part.type === 'timeZoneName',
    )?.value;
    const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name || '');
    if (!match) return -8 * 60;
    const sign = match[1] === '-' ? -1 : 1;
    return sign * (Number(match[2]) * 60 + Number(match[3] || 0));
  };
  // Two passes settle the offset across a transition.
  let result = guess - offsetAt(guess) * 60_000;
  result = guess - offsetAt(result) * 60_000;
  return result;
}

const MONTHS = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/** `Jun 15 2026  5:21PM` (CHP's zoneless Pacific stamp) → epoch ms, or null. */
export function parsePacificStamp(text) {
  const match =
    /^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*([AP]M)$/i.exec(
      String(text || '').trim(),
    );
  if (!match) return null;
  const month = MONTHS[match[1].toLowerCase()];
  if (!month) return null;
  let hour = Number(match[4]) % 12;
  if (match[6].toUpperCase() === 'PM') hour += 12;
  return pacificToUtcMs({
    year: Number(match[3]),
    month,
    day: Number(match[2]),
    hour,
    minute: Number(match[5]),
  });
}

/**
 * Classify an agency's incident type text into the shared type set. The
 * patterns run in order; the first match wins, so a "vehicle fire" is a fire
 * before it is traffic.
 */
const TYPE_RULES = [
  ['fire', /\bfire\b|\bsmoke\b|\bburn/i],
  [
    'medical',
    /\bmedical\b|\bambulance\b|\bems\b|\binjur(?:y|ies)\b.*\bmedical\b|\bcpr\b|\bunconscious\b/i,
  ],
  [
    'closure',
    /\bclosure\b|\bclosed\b|\bsig\s*alert\b|\broad\s*work\b|\bconstruction\b|\bdetour\b/i,
  ],
  ['hazard', /\bhazard\b|\bdebris\b|\banimal\b|\bobject\b|\bflood/i],
  [
    'traffic',
    /\bcollision\b|\bcrash\b|\baccident\b|\bhit\s*(?:&|and)\s*run\b|\btrfc\b|\btraffic\b|\bveh\b|\bvehicle\b|\bwrong\s*way\b|\bdui\b|\bpedestrian\b/i,
  ],
  [
    'police',
    /\bpolice\b|\brobbery\b|\bassault\b|\bburglary\b|\btheft\b|\bshoot|\bstab|\bsuspicious\b|\bdisturbance\b|\bweapon\b|\bfight\b|\bbattery\b|\bprowler\b|\btrespass/i,
  ],
];

export function classifyIncidentType(text, fallback = 'other') {
  const value = String(text || '');
  for (const [type, pattern] of TYPE_RULES)
    if (pattern.test(value)) return type;
  return fallback;
}

/** The LIVE OPS region id for a point, or null when outside every region. */
export function incidentRegionId(lat, lon) {
  return regionForPoint({ lat, lon })?.id ?? null;
}
