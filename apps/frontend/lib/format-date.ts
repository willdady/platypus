type DateInput = Date | string | number;

// why: Intl, not a formatting dependency — the viewer's own locale is the point
export function formatDate(value: DateInput): string {
  return new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" });
}

export function formatDateTime(value: DateInput): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
