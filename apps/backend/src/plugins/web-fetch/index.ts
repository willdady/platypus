import type { PlatypusPlugin } from "@platypuschat/plugin-sdk";
import { PLUGIN_API_VERSION } from "@platypuschat/plugin-sdk";
import { z } from "zod";
import { createWebFetchTools } from "../../tools/fetch.ts";

// Deploy-time plugin config (ADR-0013): the Operator sets this under
// PLATYPUS_PLUGIN_CONFIG["@platypus/web-fetch"].config. `ignoreRobotsTxt`
// replaces the former FETCH_TOOL_IGNORE_ROBOTS_TXT env var — a plugin's
// deploy-time knobs belong in its one config namespace, not a bespoke env var.
const webFetchConfigSchema = z
  .object({ ignoreRobotsTxt: z.boolean().default(false) })
  .strict();

type WebFetchConfig = z.infer<typeof webFetchConfigSchema>;

// Core plugin: the Web Fetch Tool set. Stands alone (not grouped into
// @platypus/tools-platform) because it performs network egress — the one
// capability here an Operator would plausibly want to deny in isolation
// (ADR-0013). Omit "@platypus/web-fetch" from PLATYPUS_PLUGINS to disable it
// without touching the rest of the standard tools. The Tool set id stays the
// unprefixed core id "web-fetch", so existing `agent.toolSetIds` references
// keep working.
export const plugin: PlatypusPlugin = {
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
        // Factory form: core injects the resolved plugin config at load, so the
        // tool reads `ignoreRobotsTxt` from deploy-time config, not process.env.
        tools: (_ctx, plugin) =>
          createWebFetchTools(
            (plugin?.config as WebFetchConfig | undefined)?.ignoreRobotsTxt ??
              false,
          ),
      },
    ],
  },
};
