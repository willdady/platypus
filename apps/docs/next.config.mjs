import nextra from "nextra";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const withNextra = nextra({
  // Built-in Pagefind search; skip indexing fenced code blocks.
  search: {
    codeblocks: false,
  },
});

// Deployed to Cloudflare Workers via OpenNext (ADR-0011). The site is built in
// Next.js standalone mode (no `output: 'export'`) and the OpenNext adapter wraps
// the build into a Worker. Pages are still statically generated; the Pagefind
// index is produced post-`next build` into `public/_pagefind` (see package.json).
export default withNextra({
  reactStrictMode: true,
});

// Enables Cloudflare bindings (env, assets) during `next dev`.
initOpenNextCloudflareForDev();
