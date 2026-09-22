/**
 * Absolute date rendering for the UI, built on `Intl` rather than a formatting
 * dependency. Locale is the viewer's, matching the rest of the app
 * (`kanban-card`, `kanban-card-history`).
 */

type DateInput = Date | string | number;

/** A day without a time: "Sep 21, 2026". */
export function formatDate(value: DateInput): string {
  return new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" });
}

/** A day and a time: "Sep 21, 2026, 12:00 PM". */
export function formatDateTime(value: DateInput): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
