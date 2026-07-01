import type { MetadataRoute } from "next";

// Served at /manifest.webmanifest and auto-linked by Next via <link rel="manifest">.
const manifest = (): MetadataRoute.Manifest => ({
  name: "Platypus Docs",
  short_name: "Platypus Docs",
  description:
    "Documentation for Platypus — build and manage AI agents with tool support and multi-provider capabilities.",
  start_url: "/",
  display: "standalone",
  background_color: "#ffffff",
  theme_color: "#0d9488",
  icons: [
    {
      src: "/icon-192x192.png",
      sizes: "192x192",
      type: "image/png",
    },
    {
      src: "/icon-512x512.png",
      sizes: "512x512",
      type: "image/png",
    },
  ],
});

export default manifest;
