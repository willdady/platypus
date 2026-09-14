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
export const isDataUrl = (url: string): boolean =>
  url.startsWith(DATA_URL_SCHEME);

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
 * Slice the key out of whichever form `url` carries, without judging it.
 * Returns undefined for inline content and for a URL that names no stored
 * object.
 */
const rawStorageKeyFromUrl = (url: string): string | undefined => {
  if (url.startsWith(STORAGE_URL_SCHEME)) {
    return url.slice(STORAGE_URL_SCHEME.length);
  }

  // A data: URL is inline content, not a stored reference.
  if (isDataUrl(url)) {
    return undefined;
  }

  const publicUrl = publicBaseUrl();
  if (publicUrl && url.startsWith(`${publicUrl}/`)) {
    return url.slice(publicUrl.length + 1);
  }

  // The `/files/` match is deliberately loose about the origin in front of it:
  // a deployment whose origin has changed still has rows carrying the old one,
  // and failing to recognise those would orphan their files forever.
  const markerIndex = url.lastIndexOf(FILES_ROUTE_PREFIX);
  if (markerIndex !== -1) {
    return url.slice(markerIndex + FILES_ROUTE_PREFIX.length);
  }

  return undefined;
};

/**
 * The storage key `url` refers to, or undefined when it refers to none.
 *
 * The URL came back from the client, so the key in it is untrusted. A key
 * Platypus could never have generated names nothing it stored, so callers treat
 * it the same as a URL that carried no key at all. Validity is not ownership:
 * a caller that deletes or serves must still check the key is its own.
 */
export const storageKeyFromUrl = (url: string): string | undefined => {
  const key = rawStorageKeyFromUrl(url);
  return key !== undefined && isValidStorageKey(key) ? key : undefined;
};

/**
 * The key `url` refers to, paired with whether it is one Platypus could have
 * stored. Callers that want to say something about a rejected key — a log line,
 * a placeholder part — need to tell "no key here" from "a key we refuse".
 */
export const storageKeyCandidateFromUrl = (
  url: string,
): { key: string; valid: boolean } | undefined => {
  const key = rawStorageKeyFromUrl(url);
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
