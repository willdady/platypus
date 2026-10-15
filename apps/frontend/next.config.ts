import type { NextConfig } from "next";
import rootPackage from "../../package.json" with { type: "json" };

const allowedDevOrigins = process.env.ALLOWED_DEV_ORIGINS
  ? process.env.ALLOWED_DEV_ORIGINS.split(",").map((o) => o.trim())
  : [];

const basePath = process.env.BASE_PATH || undefined;

const nextConfig: NextConfig = {
  basePath,
  // `next/link` and the router apply `basePath` themselves; `withBasePath`
  // reads this for everything else (window.location, absolute links, the
  // manifest).
  // `APP_VERSION` is the release, read from the root package.json the release
  // tooling bumps. Inlined at build; the About page is its only reader.
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath ?? "",
    APP_VERSION: rootPackage.version,
  },
  poweredByHeader: false,
  // A baseline for every response. `frame-ancestors` is the modern spelling of
  // X-Frame-Options; both are sent for older browsers.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'self'",
          },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
  output: "standalone",
  // @swc/helpers 0.5.23 added a "module-sync" export condition that resolves
  // ahead of "default". Node >=22.10 honours it for require(), so next/dist
  // loads the esm/ helpers at runtime while the standalone file tracer still
  // only follows the cjs/ ones and leaves esm/ out of the image.
  outputFileTracingIncludes: {
    "**/*": [
      "../../node_modules/.pnpm/@swc+helpers@*/node_modules/@swc/helpers/esm/**",
    ],
  },
  ...(allowedDevOrigins.length > 0 && { allowedDevOrigins }),
};

export default nextConfig;
