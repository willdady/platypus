import type { NextConfig } from "next";

const allowedDevOrigins = process.env.ALLOWED_DEV_ORIGINS
  ? process.env.ALLOWED_DEV_ORIGINS.split(",").map((o) => o.trim())
  : [];

const basePath = process.env.BASE_PATH || undefined;

const nextConfig: NextConfig = {
  basePath,
  // `next/link` and the router apply `basePath` themselves; `withBasePath`
  // reads this for everything else (window.location, absolute links, the
  // manifest).
  env: { NEXT_PUBLIC_BASE_PATH: basePath ?? "" },
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
