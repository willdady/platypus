import { isValidStorageKey } from "./keys.ts";

/**
 * The one module that knows what a File part's URL looks like (issue #839).
 *
 * A stored file's reference takes four forms across one Chat's life, and every
 * one of them is written or read here:
 *
 * - `data:<media type>[;base64],<body>` — inline content, before it is
 *   persisted and again after it is resolved for the model;
 * - `storage://<key>` — the canonical stored form ({@link storageReferenceUrl});
 * - `{STORAGE_PUBLIC_URL}/<key>` — what a reader is served on a deployment with
 *   a bucket or CDN in front ({@link servedUrlForKey});
 * - `{origin}/files/<key>` — what a reader is served otherwise, via the
 *   `/files/*` route.
 *
 * The last two round-trip through the client: a Chat resubmits its full history
 * every turn, so a stored row can carry any of the four. Every consumer takes
 * the resolved value — a key, or bytes — and parses no URL of its own; four
 * readers with four ideas of which forms exist is what made a `.txt` go
 * `[file unavailable]` from turn 2 on wherever `STORAGE_PUBLIC_URL` was set.
 *
 * Resolving bytes accepts only what this deployment itself served
 * ({@link resolvableStorageKeyFromUrl}). Cleanup reads no URL at all: deleting
 * a Chat removes everything under its key prefix.
 */

/** Scheme identifying the canonical stored form. */
const STORAGE_URL_SCHEME = "storage://";

/** Scheme identifying inline content. */
const DATA_URL_SCHEME = "data:";

/** The path `/files/*` is mounted at, and the marker its URLs are read back on. */
export const FILES_ROUTE_PREFIX = "/files/";

/** The canonical stored reference to `key`. */
export const storageReferenceUrl = (key: string): string =>
  `${STORAGE_URL_SCHEME}${key}`;

/**
 * The key `url` names when — and only when — it is the canonical stored form.
 * A part carrying a served URL came back from the client; a writer rendering
 * references for a reader must leave that one alone.
 */
export const canonicalStorageKeyFromUrl = (url: string): string | undefined =>
  url.startsWith(STORAGE_URL_SCHEME)
    ? url.slice(STORAGE_URL_SCHEME.length)
    : undefined;

/** Whether `url` is inline content rather than a reference to a stored object. */
const isDataUrl = (url: string): boolean => url.startsWith(DATA_URL_SCHEME);

/**
 * Whether `url` is one the model can neither fetch nor read bytes from: a
 * canonical reference that never got resolved (a storage miss, or a headless
 * turn that skipped resolution), or no URL at all. A served HTTP form is not
 * unfetchable — a model may still reach it.
 */
export const isUnresolvedReference = (url: string): boolean =>
  url === "" || url.startsWith(STORAGE_URL_SCHEME);

/** `STORAGE_PUBLIC_URL` without its trailing slashes, or undefined when unset. */
const publicBaseUrl = (): string | undefined =>
  process.env.STORAGE_PUBLIC_URL?.replace(/\/+$/, "") || undefined;

/**
 * The URL a reader is served for `key`: the public base when one is configured
 * (the browser fetches the bucket or CDN directly), otherwise this deployment's
 * own `/files/*` route.
 */
export const servedUrlForKey = (key: string, baseUrl: string): string => {
  const publicUrl = publicBaseUrl();
  return publicUrl
    ? `${publicUrl}/${key}`
    : `${baseUrl}${FILES_ROUTE_PREFIX}${key}`;
};

/**
 * The key `url` carries if it is one THIS deployment served — the public base
 * when one is configured, or this request's own `/files/` route. Anchoring
 * matters here: an unanchored match would let a client hand back
 * `https://anywhere.example.com/x/files/<key>` and have the backend read that
 * key out of its own store, so a URL naming someone else's host is left alone
 * as the external URL it claims to be.
 */
const servedStorageKey = (
  url: string,
  origin: string | undefined,
): string | undefined => {
  const publicUrl = publicBaseUrl();
  if (publicUrl && url.startsWith(`${publicUrl}/`)) {
    return url.slice(publicUrl.length + 1);
  }

  const filesPrefix = origin ? `${origin}${FILES_ROUTE_PREFIX}` : undefined;
  if (filesPrefix && url.startsWith(filesPrefix)) {
    return url.slice(filesPrefix.length);
  }

  return undefined;
};

/**
 * The key to read bytes back for, paired with whether it is one Platypus could
 * have stored — the inverse of {@link servedUrlForKey}. Returns undefined for
 * inline content and for a URL this deployment never served.
 *
 * The URL came back from the client, so the key in it is untrusted; the
 * validity flag is separate because a caller that refuses a key wants to say
 * so, which it can't do if a refused key and no key at all look alike. Validity
 * is not ownership.
 */
export const resolvableStorageKeyFromUrl = (
  url: string,
  origin?: string,
): { key: string; valid: boolean } | undefined => {
  if (isDataUrl(url)) {
    return undefined;
  }

  const key = canonicalStorageKeyFromUrl(url) ?? servedStorageKey(url, origin);
  return key === undefined ? undefined : { key, valid: isValidStorageKey(key) };
};

/**
 * Parse inline content into its media type and bytes, or null when `url` is not
 * a data URL.
 *
 * Deliberately permissive, because it is the only data-URL grammar in the
 * backend and it stands between the gate and persistence: an omitted media type
 * reads as `application/octet-stream` (what a paste buffer sends), a
 * URL-encoded body is decoded rather than refused, and a body split across
 * lines is accepted. A stricter second parser is what let the gate admit parts
 * persistence then declined, leaving base64 inline in the stored row.
 */
export const decodeDataUrl = (
  url: string,
): { mediaType: string; bytes: Uint8Array } | null => {
  const match = url.match(/^data:([^;,]*)(;base64)?,([\s\S]*)$/);
  if (!match) return null;
  const mediaType = match[1] || "application/octet-stream";
  const body = match[3];
  const bytes = match[2]
    ? new Uint8Array(Buffer.from(body, "base64"))
    : new Uint8Array(Buffer.from(decodeURIComponent(body), "utf8"));
  return { mediaType, bytes };
};
