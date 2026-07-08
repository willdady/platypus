import type { PlatypusPlugin } from "@platypuschat/plugin-sdk";
import { PLUGIN_API_VERSION } from "@platypuschat/plugin-sdk";
import { fetchUrl } from "../../tools/fetch.ts";

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
  contributes: {
    toolSets: [
      {
        id: "web-fetch",
        name: "Web Fetch",
        category: "Web",
        description: "Fetch content from URLs on the web",
        tools: {
          fetchUrl,
        },
      },
    ],
  },
};
