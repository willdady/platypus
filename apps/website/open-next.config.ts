import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// The marketing site is fully statically generated, so no incremental cache /
// R2 is needed. Keep the default in-Worker overrides (mirrors apps/docs).
export default defineCloudflareConfig({});
