import { bodyLimit } from "hono/body-limit";
import { AVATAR_TOO_LARGE, MAX_AVATAR_SIZE } from "../services/avatar.ts";

const MULTIPART_OVERHEAD = 64 * 1024;

export const avatarBodyLimit = bodyLimit({
  maxSize: MAX_AVATAR_SIZE + MULTIPART_OVERHEAD,
  onError: (c) => c.json({ error: AVATAR_TOO_LARGE }, 400),
});
