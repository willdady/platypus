import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Docs pages are fully statically generated, so no incremental cache / R2 is
// needed. Keep the default in-Worker overrides.
export default defineCloudflareConfig({});
