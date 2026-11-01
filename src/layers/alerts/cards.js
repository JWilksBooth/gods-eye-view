/** Card and label models for the Alerts layer. Pure — no Cesium types. */
import { formatNumber, t, tn } from '../../i18n/index.js';
import {
  ALERTS_OVERLAY_SOURCE_ID,
  alertKind,
  alertSeverity,
  severityRank,
} from './model.js';

export const ALERTS_OVERLAY_COHORT_LIMIT = 64;
export const ALERTS_OVERLAY_COLLISION_CAPACITY = 40;
/** Ambient labels stop at this many characters of headline. */
const LABEL_CHARS = 34;

/** Compact age, "5m" / "3h" / "2d", in the UI language. */
export function formatAlertAge(deltaMs) {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return null;
  const hours = Math.floor(deltaMs / 3600000);
  if (hours < 1)
    return t('{count}m', {
      context: 'age',
      count: Math.max(1, Math.floor(deltaMs / 60000)),
    });
  if (hours < 24) return t('{count}h', { context: 'age', count: hours });
  return t('{count}d', { context: 'age', count: Math.floor(hours / 24) });
}

/** Hour and minute in the viewer's local time, "14:35". */
function clock(iso) {
  const ms = Date.parse(iso || '');
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
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
      (Number.isFinite(issued) ? Math.min(999_999, Math.floor(issued / 60_000) % 1_000_000) : 0),
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

/**
 * The selected card for one alert: headline, agency and severity, kind and
 * area, timing, the start of the body, and the link line when a source
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
  const timing = [];
  const issuedAge = formatAlertAge(nowMs - Date.parse(alert.issued || ''));
  if (alert.issued && issuedAge)
    timing.push(t('issued {age} ago', { age: issuedAge }));
  const startsMs = Date.parse(alert.starts || '');
  if (Number.isFinite(startsMs) && startsMs > nowMs) {
    const until = formatAlertAge(startsMs - nowMs);
    if (until) timing.push(t('starts in {age}', { age: until }));
  }
  const ends = clock(alert.ends);
  if (ends) timing.push(t('until {time}', { time: ends }));
  if (timing.length) details.push(timing.join(' · '));
  if (alert.body) {
    const body = String(alert.body);
    details.push(body.length > 180 ? `${body.slice(0, 179).trimEnd()}…` : body);
  }
  if (alert.freshness === 'stale') details.push(t('Feed copy may be stale'));
  if (link) details.push(t('Source ↗ · click card to open'));
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
 * first at the region's anchor.
 */
export function buildBulletinCard(region, alerts, nowMs, { accent, link = null } = {}) {
  const sorted = alerts.slice().sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  const details = sorted.slice(0, 6).map((alert) => {
    const age = formatAlertAge(nowMs - Date.parse(alert.issued || alert.starts || ''));
    return [alert.headline, alert.agency, age ? t('{age} ago', { age }) : null]
      .filter(Boolean)
      .join(' · ');
  });
  if (sorted.length > 6)
    details.push(
      tn(sorted.length - 6, '{count} more bulletin', '{count} more bulletins', {
        count: formatNumber(sorted.length - 6),
      }),
    );
  if (link) details.push(t('Source ↗ · click card to open'));
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
    title: tn(sorted.length, '{region} · {count} bulletin', '{region} · {count} bulletins', {
      region: region.name,
      count: formatNumber(sorted.length),
    }),
    details,
    accent,
    priority: Number.MAX_SAFE_INTEGER,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}
