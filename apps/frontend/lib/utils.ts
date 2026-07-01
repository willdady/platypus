import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Joins a base URL and a path, ensuring no double slashes or missing slashes.
 * @param base - The base URL
 * @param path - The path to append
 * @returns The joined URL string
 */
export function joinUrl(base: string, path: string): string {
  if (!base) return path;
  const normalizedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

/**
 * Formats a tool call's run duration from its start/end ISO timestamps.
 * Returns undefined when either timestamp is missing or invalid (e.g. an
 * in-progress tool, or a historical message persisted before durations were
 * tracked) so the UI can simply render nothing.
 *
 * Output scales with magnitude: `950ms`, `1.2s`, `1m 3s`.
 */
export function formatToolDuration(
  startedAt?: string,
  completedAt?: string,
): string | undefined {
  if (!startedAt || !completedAt) return undefined;
  const start = new Date(startedAt).getTime();
  const end = new Date(completedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return undefined;
  return formatDurationMs(end - start);
}

/** Formats an elapsed millisecond span: `950ms`, `1.2s`, `1m 3s`. */
export function formatDurationMs(ms: number): string | undefined {
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remSeconds}s`;
}

export const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
  const res = await fetch(input, { ...init, credentials: "include" });
  if (!res.ok) {
    const error: Error & { info?: unknown; status?: number } = new Error(
      "An error occurred while fetching the data.",
    );
    // Attach extra info to the error object.
    const info = await res.json().catch(() => ({}));
    error.info = info;
    error.status = res.status;
    throw error;
  }
  return res.json();
};

/**
 * Parses standardschema.dev validation errors from an error response
 * @param errorData - The error response data from the API
 * @returns An object mapping field names to error messages
 */
export function getInitials(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export function parseValidationErrors(
  errorData: unknown,
): Record<string, string> {
  const errors: Record<string, string> = {};

  if (
    errorData &&
    typeof errorData === "object" &&
    "error" in errorData &&
    Array.isArray(errorData.error)
  ) {
    for (const issue of errorData.error) {
      if (
        issue &&
        typeof issue === "object" &&
        "path" in issue &&
        Array.isArray(issue.path) &&
        issue.path.length > 0 &&
        "message" in issue &&
        typeof issue.message === "string"
      ) {
        const fieldName = String(issue.path[0]);
        errors[fieldName] = issue.message;
      }
    }
  }

  return errors;
}
