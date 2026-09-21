/**
 * Absolute date rendering for the UI, built on `Intl` rather than a formatting
 * dependency. Locale is the viewer's, matching the rest of the app
 * (`kanban-card`, `kanban-card-history`).
 */

type DateInput = Date | string | number;

/** A day without a time: "Sep 21, 2026". */
export function formatDate(value: DateInput): string {
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** A day and a time: "Sep 21, 2026, 12:00 PM". */
export function formatDateTime(value: DateInput): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** A day and a time read as a sentence: "Sep 21, 2026 at 12:00 PM". */
export function formatDateAtTime(value: DateInput): string {
  const date = new Date(value);
  const time = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${formatDate(date)} at ${time}`;
}
