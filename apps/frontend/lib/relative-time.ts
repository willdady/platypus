/**
 * The one "5 minutes ago" formatter: notifications, kanban comments, and
 * trigger runs all render a timestamp relative to now, and each used to carry
 * its own copy (two hand-rolled, one inline dependency call).
 */

const SECOND = 1;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", YEAR],
  ["month", MONTH],
  ["day", DAY],
  ["hour", HOUR],
  ["minute", MINUTE],
  ["second", SECOND],
];

const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function formatRelativeTime(date: Date | string | number): string {
  const seconds = (new Date(date).getTime() - Date.now()) / 1000;
  const magnitude = Math.abs(seconds);

  const [unit, size] =
    UNITS.find(([, unitSeconds]) => magnitude >= unitSeconds) ??
    UNITS[UNITS.length - 1];

  return formatter.format(Math.round(seconds / size), unit);
}
