import { nanoid } from "nanoid";
import sharp, { type Metadata } from "sharp";
import { getStorage } from "../storage/index.ts";

const ALLOWED_AVATAR_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];
export const MAX_AVATAR_SIZE = 5 * 1024 * 1024;
export const AVATAR_TOO_LARGE = "File too large (max 5MB)";
const MIN_AVATAR_DIMENSION = 64;
const AVATAR_SIZE = 512;

export type StoreAvatarResult =
  { ok: true; key: string } | { ok: false; error: string };

export async function storeAvatar(
  file: unknown,
  agentId: string,
  previousKey: string | null | undefined,
): Promise<StoreAvatarResult> {
  if (!file || !(file instanceof File)) {
    return { ok: false, error: "No file provided" };
  }
  if (!ALLOWED_AVATAR_TYPES.includes(file.type)) {
    return { ok: false, error: "Invalid file type" };
  }
  if (file.size > MAX_AVATAR_SIZE) {
    return { ok: false, error: AVATAR_TOO_LARGE };
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  let metadata: Metadata;
  try {
    metadata = await sharp(buffer).metadata();
  } catch {
    return { ok: false, error: "Invalid image" };
  }

  if (
    metadata.width &&
    metadata.height &&
    (metadata.width < MIN_AVATAR_DIMENSION ||
      metadata.height < MIN_AVATAR_DIMENSION)
  ) {
    return {
      ok: false,
      error: `Image must be at least ${MIN_AVATAR_DIMENSION}x${MIN_AVATAR_DIMENSION} pixels`,
    };
  }

  const processedBuffer = await sharp(buffer)
    .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover" })
    .webp()
    .toBuffer();

  const key = `agents/${agentId}/avatar-${nanoid()}.webp`;

  await deleteAvatar(previousKey);
  await getStorage().put(key, processedBuffer, "image/webp");

  return { ok: true, key };
}

export async function deleteAvatar(
  key: string | null | undefined,
): Promise<void> {
  if (!key) return;
  try {
    await getStorage().delete(key);
  } catch {
    // why: a leftover avatar file is harmless, so its delete must not fail the caller
  }
}
