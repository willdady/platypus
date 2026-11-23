import { servedUrlForKey } from "../storage/file-reference.ts";

export function avatarKeyToUrl(
  avatarKey: string | null | undefined,
  baseUrl: string,
): string | null {
  if (!avatarKey) return null;
  return servedUrlForKey(avatarKey, baseUrl);
}
