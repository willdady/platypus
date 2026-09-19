import { formatDistanceToNow } from "date-fns";

/**
 * The one "5 minutes ago" formatter: notifications, kanban comments, and
 * trigger runs all render a timestamp relative to now, and each used to carry
 * its own copy (two hand-rolled, one inline `date-fns` call).
 */
export function formatRelativeTime(date: Date | string | number): string {
  return formatDistanceToNow(new Date(date), { addSuffix: true });
}
