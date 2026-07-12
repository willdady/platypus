# @platypuschat/plugin-sdk

[![npm version](https://img.shields.io/npm/v/@platypuschat/plugin-sdk.svg)](https://www.npmjs.com/package/@platypuschat/plugin-sdk)
[![license](https://img.shields.io/npm/l/@platypuschat/plugin-sdk.svg)](https://github.com/willdady/platypus/blob/main/LICENSE)

The plugin SDK for [Platypus](https://github.com/willdady/platypus) — the
compile-time contract third-party plugins are built against.

Platypus loads its extensions — **Tool sets** and **Sandbox backends** — as
plugins. This package is the typed surface they depend on: the `PlatypusPlugin`
manifest type, the contribution types, and the `PLUGIN_API_VERSION` constant. A
plugin is an npm package that exports a manifest built against these types; an
Operator installs it by adding the package to the `PLATYPUS_PLUGINS` list at
deploy time.

## Install

```bash
npm install @platypuschat/plugin-sdk
# plugins that define tools also use these directly:
npm install ai zod
```

## Quick start

Export a `PlatypusPlugin` manifest from your package entry point. This minimal
plugin contributes one Tool set with a single tool:

```ts
import type { PlatypusPlugin } from "@platypuschat/plugin-sdk";
import { PLUGIN_API_VERSION } from "@platypuschat/plugin-sdk";
import { tool } from "ai";
import { z } from "zod";

export const plugin: PlatypusPlugin = {
  // A third-party plugin's `name` is a short url-safe slug, distinct from the
  // npm package specifier an Operator lists in PLATYPUS_PLUGINS. Core prefixes
  // every contribution id with it, so `greeting` registers as `example.greeting`.
  name: "example",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  contributes: {
    toolSets: [
      {
        id: "greeting",
        name: "Greeting",
        category: "Examples",
        description: "A tiny example tool set contributed by a plugin",
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
```

An Operator then installs it by listing the published package in `PLATYPUS_PLUGINS`.

## API versioning

Set `apiVersion` from the exported `PLUGIN_API_VERSION` — it declares the
**minimum** core API major your plugin needs, not an exact match. Core supports
the current major **and one previous (N and N−1)** at the same time, and every
extension-point contract evolves **append-only** within a major (new capabilities
arrive as optional members). A plugin built against an older minor keeps working
after a core upgrade; a genuinely breaking change is a windowed major bump. Boot
is fail-loud: a plugin outside the supported window is rejected with a
plugin-named error.

## What you can contribute

- **Tool sets** (`contributes.toolSets`) — named, categorised groups of
  [Vercel AI SDK](https://sdk.vercel.ai) tools an Agent can be granted. Provide a
  static map or a factory resolved with Workspace/Agent scope at chat-turn time.
- **Sandbox backends** (`contributes.sandboxBackends`) — shell/filesystem
  execution backends for the Platypus Sandbox (e.g. the built-in Docker and SSH
  backends).

Plugins may also declare deploy-time, Operator-owned `configSchema` /
`credentialsSchema`, supplied via `PLATYPUS_PLUGIN_CONFIG` and validated at boot.

## Documentation

- [Extending Platypus](https://docs.platypus.chat/extending) — the full plugin
  model, contribution reference, and Sandbox backend guide.
- [Plugin configuration](https://docs.platypus.chat/self-hosting/configuration#plugins)
  — how Operators enable and configure plugins.

## License

MIT
