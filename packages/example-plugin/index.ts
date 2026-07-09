import type { PlatypusPlugin } from "@platypuschat/plugin-sdk";
import { PLUGIN_API_VERSION } from "@platypuschat/plugin-sdk";
import { tool } from "ai";
import { z } from "zod";

// A minimal, runnable example of a THIRD-PARTY Platypus plugin — the kind an
// Operator installs as an npm package and lists in `PLATYPUS_PLUGINS`. It exists
// to prove the third-party path end to end: dynamic `import()` resolution and
// contribution-id namespacing (ADR-0013).
//
// The manifest `name` ("example") is the namespace: because this package is NOT
// in core's built-in allowlist, the loader auto-prefixes every contribution id
// with it, so the bare `greeting` tool set below registers as `example.greeting`.
// Authors write bare ids; core prefixes at load. Core plugins stay unprefixed.
export const plugin: PlatypusPlugin = {
  name: "example",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  contributes: {
    toolSets: [
      {
        id: "greeting",
        name: "Greeting",
        category: "Examples",
        description:
          "A tiny example tool set contributed by a third-party plugin",
        tools: {
          greet: tool({
            description: "Return a friendly greeting for the given name.",
            inputSchema: z.object({
              name: z.string().describe("Who to greet"),
            }),
            execute: ({ name }) => `Hello, ${name}! 👋`,
          }),
        },
      },
    ],
  },
};
