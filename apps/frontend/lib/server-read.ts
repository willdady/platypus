import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { serverBackendUrl } from "@/lib/env";
import { joinUrl } from "@/lib/utils";
import type { Serialized } from "@/lib/api-write";

/**
 * How long a server read waits for the backend before giving up, so a hung
 * backend fails the page instead of holding the whole subtree open.
 */
export const SERVER_READ_TIMEOUT_MS = 10_000;

/**
 * What a server read came back with: the body, the status the backend
 * answered when it wasn't 2xx, or `"unreachable"` when there was no usable
 * answer — refused, timed out, or a 2xx body that isn't JSON.
 */
export type ServerReadResult<T> =
  | { ok: true; body: Serialized<T> }
  | { ok: false; status: number | "unreachable" };

/**
 * Builds a backend path with every interpolated value URL-encoded, so an id
 * from a route param can't add segments or a query string:
 * backendPath`/organizations/${orgId}`.
 */
export function backendPath(
  strings: TemplateStringsArray,
  ...values: string[]
): string {
  return strings.reduce(
    (path, part, i) =>
      path + part + (i < values.length ? encodeURIComponent(values[i]) : ""),
    "",
  );
}

/**
 * Reads one backend resource during server rendering as the signed-in user,
 * forwarding the cookie the browser sent. Never throws for a failed read; the
 * result says how it failed.
 *
 * Cached per request, so a layout, its metadata and the page under it that
 * read the same path share one backend call — the abort signal opts the
 * fetch out of Next's own deduping.
 *
 * A deployment whose frontend and backend sit on different hosts forwards no
 * session cookie (issue #819), so there the read is refused with a 401.
 */
export const serverRead = cache(async function serverRead<T>(
  path: string,
): Promise<ServerReadResult<T>> {
  const url = joinUrl(serverBackendUrl(), path);
  const cookie = (await headers()).get("cookie") || "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SERVER_READ_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { cookie },
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, status: response.status };
    return { ok: true, body: (await response.json()) as Serialized<T> };
  } catch {
    return { ok: false, status: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
});

/**
 * A server read for labels only, such as a page title: any failure comes back
 * as `null` so the caller can fall back instead of failing the page.
 */
export async function readForLabel<T>(
  path: string,
): Promise<Serialized<T> | null> {
  const result = await serverRead<T>(path);
  return result.ok ? result.body : null;
}
