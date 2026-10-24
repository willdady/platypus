import { bodyLimit } from "hono/body-limit";
import { AVATAR_TOO_LARGE, MAX_AVATAR_SIZE } from "../services/avatar.ts";

/** Headroom over the file itself for the multipart boundaries and headers. */
const MULTIPART_OVERHEAD = 64 * 1024;

/**
 * Refuses an avatar upload over the limit before buffering it, and while
 * reading it. A file under it still gets `storeAvatar`'s exact size check.
 */
export const avatarBodyLimit = bodyLimit({
  maxSize: MAX_AVATAR_SIZE + MULTIPART_OVERHEAD,
  onError: (c) => c.json({ error: AVATAR_TOO_LARGE }, 400),
});
