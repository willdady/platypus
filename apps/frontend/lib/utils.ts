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

export function getInitials(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}
