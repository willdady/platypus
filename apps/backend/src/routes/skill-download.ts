import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { SKILL_ZIP_MAX_BYTES } from "../services/skill-bundle-format.ts";

export const skillZipBodyLimit = bodyLimit({
  maxSize: SKILL_ZIP_MAX_BYTES,
  onError: (c) =>
    c.json(
      { error: `Zip is larger than ${SKILL_ZIP_MAX_BYTES / 1024 / 1024} MiB` },
      400,
    ),
});

export const attachment = (
  c: Context,
  data: Uint8Array,
  filename: string,
  contentType: string,
) => {
  c.header("Content-Type", contentType);
  c.header(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Content-Length", data.length.toString());
  return c.body(new Uint8Array(data));
};
