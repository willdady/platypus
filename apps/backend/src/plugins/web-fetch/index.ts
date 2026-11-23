import type { PlatypusPlugin } from "@platypuschat/plugin-sdk";
import { PLUGIN_API_VERSION } from "@platypuschat/plugin-sdk";
import { z } from "zod";
import { createWebFetchTools } from "../../tools/fetch.ts";

const webFetchConfigSchema = z
  .object({ ignoreRobotsTxt: z.boolean().default(false) })
  .strict();

type WebFetchConfig = z.infer<typeof webFetchConfigSchema>;

export const plugin: PlatypusPlugin<WebFetchConfig> = {
  name: "@platypus/web-fetch",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  configSchema: webFetchConfigSchema,
  contributes: {
    toolSets: [
      {
        id: "web-fetch",
        name: "Web Fetch",
        category: "Web",
        description: "Fetch content from URLs on the web",
        tools: (_ctx, plugin) =>
          createWebFetchTools(plugin.config.ignoreRobotsTxt),
      },
    ],
  },
};
