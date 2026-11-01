import { servedUrlForKey } from "../storage/file-reference.ts";

/**
 * Converts a storage avatar key to a full URL — the same rendering a File
 * part's key gets, so the two surfaces can't drift on where stored objects are
 * served from.
 */
export function avatarKeyToUrl(
  avatarKey: string | null | undefined,
  baseUrl: string,
): string | null {
  if (!avatarKey) return null;
  return servedUrlForKey(avatarKey, baseUrl);
}
