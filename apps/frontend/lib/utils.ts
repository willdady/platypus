import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function sortByName<T extends { name: string }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort((a, b) => a.name.localeCompare(b.name));
}

export function pickKeys<T extends object>(
  record: T,
  shape: Record<string, unknown>,
): Partial<T> {
  return Object.fromEntries(
    Object.keys(shape)
      .filter((key) => Object.hasOwn(record, key))
      .map((key) => [key, record[key as keyof T]]),
  ) as Partial<T>;
}

export function joinUrl(base: string, path: string): string {
  if (!base) return path;
  const normalizedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

export function errorStatus(error: unknown): number | undefined {
  if (error && typeof error === "object" && "status" in error) {
    const { status } = error as { status?: unknown };
    if (typeof status === "number") return status;
  }
  return undefined;
}

export function isNotFoundOrForbidden(error: unknown): boolean {
  const status = errorStatus(error);
  return status === 403 || status === 404;
}

async function fetchError(res: Response) {
  const error: Error & { info?: unknown; status?: number } = new Error(
    "An error occurred while fetching the data.",
  );
  error.info = await res.json().catch(() => ({}));
  error.status = res.status;
  return error;
}

export async function fetcher<T = unknown>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(input, { ...init, credentials: "include" });
  if (!res.ok) throw await fetchError(res);
  return (await res.json()) as T;
}

export async function optionalFetcher<T = unknown>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<T | null> {
  const res = await fetch(input, { ...init, credentials: "include" });
  if (res.status === 404) return null;
  if (!res.ok) throw await fetchError(res);
  return (await res.json()) as T;
}
