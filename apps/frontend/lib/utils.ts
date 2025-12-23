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

export const fetcher = (input: RequestInfo | URL, init?: RequestInit) =>
  fetch(input, { ...init, credentials: "include" }).then((res) => res.json());

/**
 * Parses standardschema.dev validation errors from an error response
 * @param errorData - The error response data from the API
 * @returns An object mapping field names to error messages
 */
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
