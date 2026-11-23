import { isValidStorageKey } from "./keys.ts";
import { env } from "../env.ts";

const STORAGE_URL_SCHEME = "storage://";

const DATA_URL_SCHEME = "data:";

export const FILES_ROUTE_PREFIX = "/files/";

export const storageReferenceUrl = (key: string): string =>
  `${STORAGE_URL_SCHEME}${key}`;

export const canonicalStorageKeyFromUrl = (url: string): string | undefined =>
  url.startsWith(STORAGE_URL_SCHEME)
    ? url.slice(STORAGE_URL_SCHEME.length)
    : undefined;

const isDataUrl = (url: string): boolean => url.startsWith(DATA_URL_SCHEME);

export const isUnresolvedReference = (url: string): boolean =>
  url === "" || url.startsWith(STORAGE_URL_SCHEME);

const publicBaseUrl = (): string | undefined => env().STORAGE_PUBLIC_URL;

export const storagePublicBaseUrl = (): string | null =>
  publicBaseUrl() ?? null;

export const servedUrlForKey = (key: string, baseUrl: string): string => {
  const publicUrl = publicBaseUrl();
  return publicUrl
    ? `${publicUrl}/${key}`
    : `${baseUrl}${FILES_ROUTE_PREFIX}${key}`;
};

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

export const resolvableStorageKeyFromUrl = (
  url: string,
  origin: string,
): { key: string; valid: boolean } | undefined => {
  if (isDataUrl(url)) {
    return undefined;
  }

  const key = canonicalStorageKeyFromUrl(url) ?? servedStorageKey(url, origin);
  return key === undefined ? undefined : { key, valid: isValidStorageKey(key) };
};

export const decodeDataUrl = (
  url: string,
): { mediaType: string; bytes: Uint8Array } | null => {
  const match = url.match(/^data:([^;,]*)(;base64)?,([\s\S]*)$/);
  const body = match?.[3];
  if (!match || body === undefined) return null;
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty media type gets the default too
  const mediaType = match[1] || "application/octet-stream";
  const bytes = match[2]
    ? new Uint8Array(Buffer.from(body, "base64"))
    : new Uint8Array(Buffer.from(decodeURIComponent(body), "utf8"));
  return { mediaType, bytes };
};
