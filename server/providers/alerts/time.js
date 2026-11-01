/**
 * Local wall-clock times without an offset, as some agency feeds publish
 * them, converted to instants. Intl is the only portable source of the
 * daylight-saving rules, so the zone offset is read from it.
 */

/**
 * The offset, in minutes east of UTC, that a time zone has at an instant.
 * @param {number} ms
 * @param {string} timeZone
 */
export function zoneOffsetMinutes(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  return Math.round((asUtc - ms) / 60_000);
}

/**
 * Epoch milliseconds for a wall-clock time in a zone, or null. The offset is
 * resolved twice so a time near a daylight-saving change lands on the right
 * side of it.
 */
export function zonedTimeToMs(
  { year, month, day, hour = 0, minute = 0, second = 0 },
  timeZone,
) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(naive)) return null;
  let utc = naive - zoneOffsetMinutes(naive, timeZone) * 60_000;
  utc = naive - zoneOffsetMinutes(utc, timeZone) * 60_000;
  return Number.isFinite(utc) ? utc : null;
}

const MONTHS = Object.freeze({
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
});

/**
 * Epoch milliseconds for a long-form local date such as
 * `Friday, October 30, 2026 - 21:57` or `October 30, 2026 9:57 PM`, read in
 * the given zone; null when the text is not one.
 */
export function parseLongLocalDate(text, timeZone) {
  const match =
    /(?:^|\s|,)([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})(?:\s*[-–,]?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?/.exec(
      String(text ?? '').trim(),
    );
  if (!match) return null;
  const month = MONTHS[match[1].slice(0, 3).toLowerCase()];
  if (!month) return null;
  let hour = Number(match[4] ?? 0);
  const meridiem = match[7]?.toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour > 23) return null;
  return zonedTimeToMs(
    {
      year: Number(match[3]),
      month,
      day: Number(match[2]),
      hour,
      minute: Number(match[5] ?? 0),
      second: Number(match[6] ?? 0),
    },
    timeZone,
  );
}
