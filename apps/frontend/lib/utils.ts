import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const fetcher = (...args: Parameters<typeof fetch>) =>
  fetch(...args).then((res) => res.json());

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
