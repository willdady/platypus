import type { Context } from "hono";

/**
 * Extract the public-facing origin from a Hono request context.
 *
 * Behind a TLS-terminating reverse proxy the backend receives plain HTTP
 * requests, so `new URL(c.req.url).origin` would return `http://…` even
 * though the client connected over HTTPS. This helper checks the standard
 * `X-Forwarded-Proto` / `X-Forwarded-Host` headers first and falls back
 * to the raw request URL.
 */
export function getOrigin(c: Context): string {
  const proto = c.req.header("x-forwarded-proto");
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host");

  if (proto && host) {
    return `${proto}://${host}`;
  }

  return new URL(c.req.url).origin;
}
