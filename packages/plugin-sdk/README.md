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
  // A third-party plugin's `name` is a short url-safe slug (up to 24
  // characters), distinct from the npm package specifier an Operator lists in
  // PLATYPUS_PLUGINS. Core prefixes every contribution id with it, so `greeting`
  // registers as `example.greeting`, and every tool name, so `greet` below is
  // called as `example__greet`.
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
          // Bare, like the id — core namespaces it to `example__greet`. Up to
          // 32 characters; over that fails boot.
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

**v2 is the current major**, and a v1 plugin still loads on it. v2 made required
everything core had always supplied on every turn — `ctx.registerCloser`,
`plugin.logger`, and the `plugin` argument on all three contribution factories —
so none of them needs a `?.` any more. It also re-signed one member: a Sandbox
backend's `configSchema` **factory** now receives the whole deploy-time block
rather than the `config` half alone, so read `plugin.config` where the argument
used to be the config itself.

Raising `apiVersion` to 2 is what makes those unguarded reads safe. Dropping the
guards while the manifest still says 1 is the trap — a core on the previous
release will load the plugin, because 1 is inside its window, and the first
unguarded read throws mid-turn.

## What you can contribute

- **Tool sets** (`contributes.toolSets`) — named, categorised groups of
  [Vercel AI SDK](https://sdk.vercel.ai) tools an Agent can be granted. Provide a
  static map or a factory resolved with Workspace/Agent scope at chat-turn time.
- **Sandbox backends** (`contributes.sandboxBackends`) — shell/filesystem
  execution backends for the Platypus Sandbox (e.g. the built-in Docker and SSH
  backends).
- **Web-search backends** (`contributes.webBackends`) — see below.

Plugins may also declare deploy-time, Operator-owned `configSchema` /
`credentialsSchema`, supplied via the plugin's own `PLATYPUS_PLUGIN_CONFIG_<NAME>`
variable and validated at boot.

## Logging

Don't reach for `console.*` or bundle a logger. Core puts a `PluginLogger` on the
deploy-time block every contribution factory receives, already bound to your
manifest `name`, so your lines join core's own structured stream at the verbosity
the Operator set with `LOG_LEVEL`:

```ts
tools: (ctx, plugin) => {
  // `debug` / `info` / `warn` / `error`, each taking a fields object with an
  // optional message, or a message on its own.
  plugin.logger.info({ workspaceId: ctx.workspaceId }, "Resolving tool set");
  return {/* … */};
};
```

Prefer the object form — those fields stay queryable where an interpolated string
does not. Don't put your plugin's name in them; core binds it for you. The block
and its `logger` are both required from `apiVersion: 2` on, so neither needs a
`?.`; on `apiVersion: 1` write `plugin?.logger?.` instead.

## Closing what a factory opened

Tool set factories and Web-search backends are resolved **once per Chat turn**. If
yours opens something with a lifetime — a pool, a browser page, a keep-alive
socket — hand core its close:

```ts
tools: (ctx) => {
  const client = connect(ctx.workspaceId);
  ctx.registerCloser(() => client.close());
  return createTools(client);
};
```

Core runs it once, when the turn ends, on a normal finish and on the User
cancelling alike. The same function registered twice **in one turn** runs once —
registration is per turn, so register what the turn opened and not a pool you mean
to keep between turns. A closer that throws is logged against your plugin and the
rest still run; one that never settles is abandoned after 5 seconds, because
teardown happens while the reader is still waiting on the reply.

The unguarded call above needs `apiVersion: 2`. Writing it while your manifest
still says 1 is the trap: an older core loads the plugin, the member is genuinely
absent there, and the call is a `TypeError` thrown out of your factory — your
contribution then serves **nothing** that turn. Either raise the number or write
`ctx.registerCloser?.(…)`.

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
        createExecutors: (ctx, plugin) => {
          const pool = createPool(plugin.config.endpoint);
          // Anything with a lifetime gets a close core will run when the turn
          // ends — on a normal finish and on a cancellation alike. Guarded,
          // never `!`: the member is optional so this plugin still loads on a
          // core that predates it, and an unguarded call would cost the turn
          // its search tools entirely.
          ctx.registerCloser(() => pool.close());
          return {
            // Mandatory. Return results; never truncate or paginate — core does.
            // `signal` fires when the User cancels or `timeoutMs` runs out;
            // forward it and your upstream request stops with the turn.
            web_search: async ({ query }, { signal }) => ({
              query,
              results: await pool.search(query, { signal }),
              // Optional: an upstream answer box (Brave, Tavily) survives here.
              answer: undefined,
            }),
            // Optional. Omit it and the model just gets search that turn.
            read_url: async ({ url }, { signal }) => ({
              content: await pool.render(url, { signal }), // FULL text — core slices it
              url, // the post-redirect final URL, so the model cites where it landed
              contentType: "text/markdown",
            }),
          };
        },
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

`AbortSignal` is a platform global rather than something this package declares, so
a `tsconfig.json` with `"lib": ["esnext"]` and no `@types/node` reports `Cannot
find name 'AbortSignal'`. Add `@types/node` — you are running on Node — or `"dom"`
to `lib`. A one-argument executor written before the signal existed still
compiles and still works.

## Documentation

- [Extending Platypus](https://docs.platypus.chat/extending) — the full plugin
  model, contribution reference, and Sandbox backend guide.
- [Plugin configuration](https://docs.platypus.chat/self-hosting/configuration#plugins)
  — how Operators enable and configure plugins.

## License

MIT
