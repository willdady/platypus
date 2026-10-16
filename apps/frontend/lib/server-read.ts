import "server-only";
import { headers } from "next/headers";
import { serverBackendUrl } from "@/lib/env";
import { joinUrl } from "@/lib/utils";

/**
 * Reads one backend resource during server rendering as the signed-in user,
 * forwarding the cookie the browser sent. For labels only, such as a page
 * title: any failure — refused, missing, unreachable — comes back as `null` so
 * the caller can fall back instead of failing the page.
 *
 * A deployment whose frontend and backend sit on different hosts forwards no
 * session cookie (issue #819), so there the read is refused and the caller's
 * fallback is what shows.
 */
export async function readForLabel<T>(path: string): Promise<T | null> {
  try {
    const headersList = await headers();
    const response = await fetch(joinUrl(serverBackendUrl(), path), {
      headers: { cookie: headersList.get("cookie") || "" },
    });
    return response.ok ? ((await response.json()) as T) : null;
  } catch {
    return null;
  }
}
