import type { MetadataRoute } from "next";
import { appRoutes, withBasePath } from "@/lib/routes";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Platypus",
    short_name: "Platypus",
    description:
      "A rich web interface for interacting with AI chatbots and agents",
    start_url: withBasePath(appRoutes.home),
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#0d9488",
    icons: [
      {
        src: withBasePath("/icon-192x192.png"),
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: withBasePath("/icon-512x512.png"),
        sizes: "512x512",
        type: "image/png",
      },
    ],
  };
}
