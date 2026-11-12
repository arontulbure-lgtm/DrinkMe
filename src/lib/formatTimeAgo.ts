// Shared, pure "time ago" label for posts and comments. No React and no global state: the caller
// passes the translate function from useLocalization() and, in tests, a fixed `now`.

export type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
// Older than this shows a short date instead of "Xd".
const RELATIVE_LIMIT_MS = 7 * DAY_MS;
// A timestamp slightly in the future (device clock behind the server) still reads as "just now".
const CLOCK_SKEW_MS = 5 * MINUTE_MS;

function toTimestamp(value: Date | string | number | null | undefined): number {
  if (value === null || value === undefined || value === '') return NaN;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : NaN;
}

const SAME_YEAR_OPTIONS: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
const OTHER_YEAR_OPTIONS: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' };

// One formatter per (locale, sameYear): building an Intl.DateTimeFormat is costly, and a feed renders many dates.
// Only a handful of keys can ever exist (one per supported locale × 2).
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(dateLocale: string, sameYear: boolean): Intl.DateTimeFormat {
  const cacheKey = `${dateLocale}|${sameYear ? 'y' : 'n'}`;
  const cached = formatterCache.get(cacheKey);
  if (cached) return cached;
  const options = sameYear ? SAME_YEAR_OPTIONS : OTHER_YEAR_OPTIONS;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat(dateLocale, options);
  } catch {
    // An unknown locale tag throws a RangeError; fall back to the runtime default.
    formatter = new Intl.DateTimeFormat(undefined, options);
  }
  formatterCache.set(cacheKey, formatter);
  return formatter;
}

function formatShortDate(time: number, nowTime: number, t: TranslateFn): string {
  const date = new Date(time);
  const sameYear = date.getFullYear() === new Date(nowTime).getFullYear();
  // time.dateLocale is a BCP 47 tag kept with the translations (en-GB, ro-RO).
  return getFormatter(t('time.dateLocale'), sameYear).format(date);
}

/**
 * Localized relative time: "Just now", "5m ago", "3h ago", "1d ago", "2d ago" (ro: "Chiar acum", "acum 5 min", "acum o zi", "acum 2 zile"),
 * and a short date (e.g. "12 Nov" or "12 Nov 2025") from 7 days on.
 * Invalid input returns an empty string. A future date within 5 minutes reads as "just now";
 * further in the future it shows the short date.
 */
export function formatTimeAgo(
  date: Date | string | number | null | undefined,
  t: TranslateFn,
  now: Date | number = Date.now()
): string {
  const time = toTimestamp(date);
  const nowTime = now instanceof Date ? now.getTime() : now;
  if (Number.isNaN(time) || !Number.isFinite(nowTime)) return '';

  const diff = nowTime - time;
  if (diff < -CLOCK_SKEW_MS) return formatShortDate(time, nowTime, t);
  if (diff < MINUTE_MS) return t('time.justNow');
  if (diff < HOUR_MS) return t('time.minutesAgo', { count: Math.floor(diff / MINUTE_MS) });
  if (diff < DAY_MS) return t('time.hoursAgo', { count: Math.floor(diff / HOUR_MS) });
  if (diff < RELATIVE_LIMIT_MS) {
    const days = Math.floor(diff / DAY_MS);
    // Separate key for one day: Romanian says "acum o zi", not "acum 1 zile".
    return days === 1 ? t('time.dayAgo') : t('time.daysAgo', { count: days });
  }
  return formatShortDate(time, nowTime, t);
}
