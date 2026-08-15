# @platypuschat/plugin-sdk

[![npm version](https://img.shields.io/npm/v/@platypuschat/plugin-sdk.svg)](https://www.npmjs.com/package/@platypuschat/plugin-sdk)
[![license](https://img.shields.io/npm/l/@platypuschat/plugin-sdk.svg)](https://github.com/willdady/platypus/blob/main/LICENSE)

The plugin SDK for [Platypus](https://github.com/willdady/platypus) — the
compile-time contract third-party plugins are built against.

Platypus loads its extensions — **Tool sets**, **Sandbox backends**, and
**Web-search backends** — as plugins. This package is the typed surface they
depend on: the `PlatypusPlugin` manifest type, the contribution types, and the
`PLUGIN_API_VERSION` constant. A plugin is an npm package that exports a
manifest built against these types; an Operator installs it by adding the
package to the `PLATYPUS_PLUGINS` list at deploy time.

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
- **Web-search backends** (`contributes.webBackends`) — see below.

Plugins may also declare deploy-time, Operator-owned `configSchema` /
`credentialsSchema`, supplied via `PLATYPUS_PLUGIN_CONFIG` and validated at boot.

## Logging

Don't reach for `console.*` or bundle a logger. Core puts a `PluginLogger` on the
deploy-time block every contribution factory receives, already bound to your
manifest `name`, so your lines join core's own structured stream at the verbosity
the Operator set with `LOG_LEVEL`:

```ts
tools: (ctx, plugin) => {
  // `debug` / `info` / `warn` / `error`, each taking a fields object with an
  // optional message, or a message on its own.
  plugin?.logger?.info({ workspaceId: ctx.workspaceId }, "Resolving tool set");
  return {/* … */};
};
```

Prefer the object form — those fields stay queryable where an interpolated string
does not. Don't put your plugin's name in them; core binds it for you. And keep
the optional chaining: `logger` is an appended optional member, so
`plugin?.logger?.` is what lets the same code run on a core that predates it.

## Web-search backends

A Web-search backend fills the chat **web-search toggle** for Providers without
working native search (self-hosted OpenAI-compatible servers: vLLM, LiteLLM,
SGLang…). An Operator selects one **per Provider**; its tools are injected only
while the toggle is on, and gone when it is off.

Your backend supplies **executors** — plain functions — not tools. Core builds the
`web_search` / `read_url` tools around them and owns the input schemas, the
model-facing descriptions, result caps and snippet truncation, `max_length` /
`start_index` slicing with a continuation hint, the timeout on both your factory
and every executor call, the throw→error contract, and an egress guard on the
model-supplied URL. Core also _drops_ any result whose `url` is not `http(s)` or
is longer than 2048 characters, since neither can be presented as a link. That keeps
one fixed model-facing signature across every backend, and it is the only place
those limits can actually be enforced.

```ts
import type { PlatypusPlugin } from "@platypuschat/plugin-sdk";
import { PLUGIN_API_VERSION } from "@platypuschat/plugin-sdk";

export const plugin: PlatypusPlugin = {
  name: "acme-search",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  // A backend's endpoint and API key are deploy-time plugin config, not
  // per-Provider settings — declare them with the plugin-level schemas.
  contributes: {
    webBackends: [
      {
        backend: "searx", // registers as `acme-search.searx`
        name: "SearXNG",
        // Optional; core defaults to 30_000 and caps at 120_000. It bounds
        // `createExecutors` as well as each executor call, so budget for any lazy
        // work the factory does — a factory that outruns it, or throws, serves no
        // web tools that turn (warn-logged, never fatal).
        timeoutMs: 5_000,
        createExecutors: (ctx, plugin) => ({
          // Mandatory. Return results; never truncate or paginate — core does.
          web_search: async ({ query }) => ({
            query,
            results: [{ title: "…", url: "https://…", snippet: "…" }],
            // Optional: an upstream answer box (Brave, Tavily) survives here.
            answer: undefined,
          }),
          // Optional. Omit it and the model just gets search that turn.
          read_url: async ({ url }) => ({
            content: "the page's FULL text — core slices it",
            url, // the post-redirect final URL, so the model cites where it landed
            contentType: "text/markdown",
          }),
        }),
      },
    ],
  },
};
```

Note the casing: SDK types are camelCase (`contentType`), while the tool names and
the model-facing return fields are snake_case (`web_search`, `read_url`,
`content_type`, `next_start_index`) to match provider-native search and Platypus's
own `fetchUrl`. There are deliberately no per-contribution config schemas — a web
backend has no per-Provider row to validate, so its credentials ride the
plugin-level `credentialsSchema` and arrive as `plugin.credentials`.

## Documentation

- [Extending Platypus](https://docs.platypus.chat/extending) — the full plugin
  model, contribution reference, and Sandbox backend guide.
- [Plugin configuration](https://docs.platypus.chat/self-hosting/configuration#plugins)
  — how Operators enable and configure plugins.

## License

MIT
