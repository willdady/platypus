import type { NextConfig } from "next";
import rootPackage from "../../package.json" with { type: "json" };
import { ARTIFACT_FRAME_HOST_CSP } from "./lib/artifact-frame";

const allowedDevOrigins = process.env.ALLOWED_DEV_ORIGINS
  ? process.env.ALLOWED_DEV_ORIGINS.split(",").map((o) => o.trim())
  : [];

const basePath = process.env.BASE_PATH || undefined;

const nextConfig: NextConfig = {
  basePath,
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath ?? "",
    APP_VERSION: rootPackage.version,
  },
  poweredByHeader: false,
  headers() {
    return Promise.resolve([
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: `frame-ancestors 'self'; ${ARTIFACT_FRAME_HOST_CSP}`,
          },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ]);
  },
  output: "standalone",
  outputFileTracingIncludes: {
    "**/*": [
      "../../node_modules/.pnpm/@swc+helpers@*/node_modules/@swc/helpers/esm/**",
    ],
  },
  ...(allowedDevOrigins.length > 0 && { allowedDevOrigins }),
};

export default nextConfig;
