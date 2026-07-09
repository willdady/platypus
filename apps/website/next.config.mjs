import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

/**
 * Deployed to Cloudflare Workers via OpenNext, mirroring apps/docs (ADR-0011).
 * The single-page marketing site is statically generated; the OpenNext adapter
 * wraps the standalone build into a Worker (see open-next.config.ts).
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  reactStrictMode: true,
  // The site ships a single small static logo; skip the image-optimization
  // runtime (not wired up on Cloudflare Workers) and serve it as-is.
  images: {
    unoptimized: true,
  },
};

// Enables Cloudflare bindings (env, assets) during `next dev`.
initOpenNextCloudflareForDev();

export default nextConfig;
