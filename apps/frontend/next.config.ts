import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      {
        source: "/:orgId/workspace/:workspaceId/settings",
        destination: "/:orgId/workspace/:workspaceId/settings/providers",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
