type DateInput = Date | string | number;

// why: Intl, not a formatting dependency — the viewer's own locale is the point
export function formatDate(value: DateInput, locale?: string): string {
  return new Date(value).toLocaleDateString(locale, { dateStyle: "medium" });
}

export function formatDateTime(value: DateInput, locale?: string): string {
  return new Date(value).toLocaleString(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
