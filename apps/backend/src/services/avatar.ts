import { nanoid } from "nanoid";
import sharp, { type Metadata } from "sharp";
import { getStorage } from "../storage/index.ts";

/**
 * Agent avatar handling — validation, resizing, and storage — in one place.
 *
 * Persisting the key on the Agent row is `setAgentAvatar`/`clearAgentAvatar`
 * in the Agent service, shared by the Workspace and Organization surfaces.
 * The image rules (allowed types, size/dimension limits, the resize target)
 * and the storage key scheme live here so they cannot drift apart.
 */

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

/**
 * Outcome of {@link storeAvatar}. A rejected upload carries a human-readable
 * message, which `setAgentAvatar` throws as a `ValidationError` (400).
 */
export type StoreAvatarResult =
  { ok: true; key: string } | { ok: false; error: string };

/**
 * Validate, resize, and store an uploaded avatar for an Agent, deleting the
 * previous avatar (if any) once the new one is stored.
 *
 * The returned key is keyed by the Agent's globally-unique id and is
 * independent of scope, so it never goes stale when a Workspace Agent is
 * Promoted to the Organization (ADR-0007). The caller persists the key on the
 * Agent row.
 *
 * @param file - The raw value pulled from `parseBody()` — validated here.
 * @param agentId - The Agent the avatar belongs to (used in the storage key).
 * @param previousKey - The Agent's current avatar key, deleted on success.
 */
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

/**
 * Delete an avatar from storage if a key is present. Storage errors are
 * swallowed: an avatar that is missing or already gone must not fail the
 * request that is clearing or replacing it.
 */
export async function deleteAvatar(
  key: string | null | undefined,
): Promise<void> {
  if (!key) return;
  try {
    await getStorage().delete(key);
  } catch {
    // Ignore deletion errors
  }
}
