import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { serverBackendUrl } from "@/lib/env";
import { joinUrl } from "@/lib/utils";
import type { Serialized } from "@/lib/api-write";

export const SERVER_READ_TIMEOUT_MS = 10_000;

export type ServerReadResult<T> =
  | { ok: true; body: Serialized<T> }
  | { ok: false; status: number | "unreachable" };

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

// why: cache() shares one read per request; the abort signal opts out of Next's fetch dedupe
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

export async function readForLabel<T>(
  path: string,
): Promise<Serialized<T> | null> {
  const result = await serverRead<T>(path);
  return result.ok ? result.body : null;
}
