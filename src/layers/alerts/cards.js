/** Card and label models for the Alerts layer. Pure — no Cesium types. */
import {
  formatDate,
  formatNumber,
  formatRelativeTime,
  t,
  tn,
} from '../../i18n/index.js';
import { alertKind, alertSeverity, severityRank } from './model.js';

export const ALERTS_OVERLAY_COHORT_LIMIT = 64;
export const ALERTS_OVERLAY_COLLISION_CAPACITY = 40;
/** Ambient labels stop at this many characters of headline. */
const LABEL_CHARS = 34;
/** Bulletins listed on a region card before "N more". */
const BULLETIN_LINES = 6;

/**
 * A time relative to now in the UI language ("2 hours ago", "in 3 hours"),
 * or null for an unknown time.
 */
export function relativeTime(ms, nowMs) {
  if (!Number.isFinite(ms) || !Number.isFinite(nowMs)) return null;
  // Round away from now symmetrically: 90 minutes ago reads "2 hours ago",
  // as 90 minutes ahead reads "in 2 hours".
  const round = (value) => Math.sign(value) * Math.round(Math.abs(value));
  const minutes = round((ms - nowMs) / 60_000);
  if (Math.abs(minutes) < 60) return formatRelativeTime(minutes, 'minute');
  const hours = round(minutes / 60);
  if (Math.abs(hours) < 48) return formatRelativeTime(hours, 'hour');
  return formatRelativeTime(round(hours / 24), 'day');
}

/** Hour and minute in the viewer's local time and language. */
function clock(ms) {
  if (!Number.isFinite(ms)) return null;
  return formatDate(new Date(ms), { hour: '2-digit', minute: '2-digit' });
}

/** The severity band's label in the UI language. */
export function severityLabel(severity) {
  return t(alertSeverity(severity).label);
}

/** The kind's label in the UI language, or the raw id for an unknown kind. */
export function kindLabel(kind) {
  const descriptor = alertKind(kind);
  return descriptor ? t(descriptor.label) : String(kind ?? '');
}

/** The host a source link opens, without `www.`, or null. */
export function sourceHost(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/** A short headline for an ambient label. */
export function labelHeadline(alert) {
  const text = String(alert?.headline || '').trim();
  return text.length > LABEL_CHARS
    ? `${text.slice(0, LABEL_CHARS - 1).trimEnd()}…`
    : text;
}

/**
 * The ambient label for one alert with a position. Worse and newer alerts
 * win the label budget.
 */
export function createAlertOverlayEntry({ id, position, alert, accent }) {
  const issued = Date.parse(alert?.issued || alert?.starts || '');
  return {
    id: String(id),
    position,
    variant: 'label',
    title: labelHeadline(alert),
    accent,
    priority:
      severityRank(alert?.severity) * 1_000_000 +
      (Number.isFinite(issued)
        ? Math.min(999_999, Math.floor(issued / 60_000) % 1_000_000)
        : 0),
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 14,
    verticalOnly: true,
    placement: 'above',
  };
}

/** Keep the worst alerts' labels, with stable identity as the tie-break. */
export function selectAlertOverlayCohort(
  entries,
  limit = ALERTS_OVERLAY_COHORT_LIMIT,
) {
  const cap = Math.max(
    0,
    Math.min(ALERTS_OVERLAY_COHORT_LIMIT, Math.floor(Number(limit) || 0)),
  );
  if (!Array.isArray(entries) || cap === 0) return [];
  return entries
    .slice()
    .sort(
      (a, b) =>
        b.priority - a.priority || String(a.id).localeCompare(String(b.id)),
    )
    .slice(0, cap);
}

/** The when line of a card: issued, starting, ending. */
function timingLine(alert, nowMs) {
  const timing = [];
  const issuedMs = Date.parse(alert.issued || '');
  const issued = relativeTime(issuedMs, nowMs);
  if (issued && issuedMs <= nowMs)
    timing.push(t('Issued {when}', { when: issued }));
  const startsMs = Date.parse(alert.starts || '');
  if (Number.isFinite(startsMs) && startsMs > nowMs)
    timing.push(t('Starts {when}', { when: relativeTime(startsMs, nowMs) }));
  const ends = clock(Date.parse(alert.ends || ''));
  if (ends) timing.push(t('Until {time}', { time: ends }));
  return timing.join(' · ');
}

/**
 * The selected card for one alert: headline, agency and severity, kind and
 * area, timing, the start of the body, and the source line when a source
 * page exists. The caller supplies `position` separately.
 */
export function buildAlertCard(alert, nowMs, { accent, link = null } = {}) {
  const details = [];
  details.push(
    [alert.agency, severityLabel(alert.severity)].filter(Boolean).join(' · '),
  );
  const where = [kindLabel(alert.kind), alert.areaDescription]
    .filter(Boolean)
    .join(' · ');
  if (where) details.push(where);
  if (alert.areaSource === 'centroid')
    details.push(t('Placed at the county centre; the feed gave no shape'));
  const timing = timingLine(alert, nowMs);
  if (timing) details.push(timing);
  if (alert.body) {
    const body = String(alert.body);
    details.push(body.length > 180 ? `${body.slice(0, 179).trimEnd()}…` : body);
  }
  if (alert.freshness === 'stale') details.push(t('Feed copy may be stale'));
  const host = link ? sourceHost(link) : null;
  if (host) details.push(`${host} ↗ · ${t('Click card to open the source')}`);
  return {
    id: `alert-card:${alert.id}`,
    selected: true,
    interactive: Boolean(link),
    ...(link
      ? {
          accessibilityLabel: t('Open {title} at its source', {
            title: alert.headline,
          }),
        }
      : undefined),
    title: alert.headline,
    details,
    accent,
    priority: Number.MAX_SAFE_INTEGER,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}

/**
 * The selected card for a region's bulletins: alerts that carry no
 * geometry of their own (transit advisories, agency news), listed worst
 * first at the region's centre.
 */
export function buildBulletinCard(
  region,
  alerts,
  nowMs,
  { accent, link = null } = {},
) {
  const sorted = alerts
    .slice()
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  const details = sorted.slice(0, BULLETIN_LINES).map((alert) => {
    const when = relativeTime(
      Date.parse(alert.issued || alert.starts || ''),
      nowMs,
    );
    return [alert.headline, alert.agency, when].filter(Boolean).join(' · ');
  });
  if (sorted.length > BULLETIN_LINES)
    details.push(
      tn(
        sorted.length - BULLETIN_LINES,
        '{count} more bulletin',
        '{count} more bulletins',
        { count: formatNumber(sorted.length - BULLETIN_LINES) },
      ),
    );
  const host = link ? sourceHost(link) : null;
  if (host) details.push(`${host} ↗ · ${t('Click card to open the source')}`);
  return {
    id: `alert-bulletins:${region.id}`,
    selected: true,
    interactive: Boolean(link),
    ...(link
      ? {
          accessibilityLabel: t('Open {title} at its source', {
            title: sorted[0]?.headline || region.name,
          }),
        }
      : undefined),
    title: tn(
      sorted.length,
      '{region} · {count} bulletin',
      '{region} · {count} bulletins',
      { region: region.name, count: formatNumber(sorted.length) },
    ),
    details,
    accent,
    priority: Number.MAX_SAFE_INTEGER,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}
