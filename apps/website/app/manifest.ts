import type { MetadataRoute } from "next";

// Served at /manifest.webmanifest and auto-linked by Next via <link rel="manifest">.
// Enables "Add to Home Screen" and defines the app's name, icons, and theme.
const manifest = (): MetadataRoute.Manifest => ({
  name: "Platypus — Self-Hosted Platform for Building AI Agents",
  short_name: "Platypus",
  description:
    "Platypus is a self-hosted, multi-tenant platform for building AI agents that reason, use tools, and connect to your data via the Model Context Protocol.",
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
