/**
 * Converts a storage avatar key to a full URL.
 * Uses STORAGE_PUBLIC_URL if set, otherwise proxies through /files/ endpoint.
 */
export function avatarKeyToUrl(
  avatarKey: string | null | undefined,
  baseUrl: string,
): string | null {
  if (!avatarKey) return null;
  const publicUrl = process.env.STORAGE_PUBLIC_URL;
  return publicUrl
    ? `${publicUrl}/${avatarKey}`
    : `${baseUrl}/files/${avatarKey}`;
}
