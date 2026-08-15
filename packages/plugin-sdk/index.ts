import type { Tool } from "ai";
import type { z } from "zod";

/**
 * The current major of the plugin API surface. A plugin's manifest `apiVersion`
 * states the **minimum** core API it needs, not an exact match.
 *
 * ## Compatibility policy (enforced at boot; see ADR-0013)
 *
 * Compatibility is **forward-compatible with minimum-version semantics** — a
 * core upgrade must never break an in-the-wild plugin. Core supports the current
 * major **and one previous (N and N−1)** simultaneously, so the accepted window
 * is `[OLDEST_SUPPORTED_API_VERSION, PLUGIN_API_VERSION]`. At boot core rejects a
 * plugin only when its `apiVersion` is:
 *
 * - **newer than core** (`apiVersion > PLUGIN_API_VERSION`) — the plugin needs a
 *   capability this core does not yet provide; the Operator fixes it by
 *   upgrading core, which they control; or
 * - **below core's oldest supported major** (`apiVersion <
 *   OLDEST_SUPPORTED_API_VERSION`) — the plugin targets a dropped, long-
 *   deprecated major.
 *
 * ## The append-only contract policy
 *
 * Within a major, every Extension-point contract in this SDK evolves
 * **append-only**: a new capability arrives as an **optional** member (an
 * optional method or field), never as a new required member. That is what lets a
 * plugin built against an older minor keep working after a core bump — the older
 * plugin simply doesn't use the members it never knew about. Adding a whole
 * Extension point (e.g. a messaging gateway) is likewise additive: a new optional
 * key on {@link PluginContributions}.
 *
 * A genuinely **breaking** change — removing or re-signing a required member — is
 * a **windowed major bump**: the major increments, and during the window core
 * runs both N and N−1 so authors have a release to migrate.
 */
export const PLUGIN_API_VERSION = 1 as const;

/**
 * The oldest plugin API major core still accepts — one below the current major
 * (the "N−1" of the N-and-N−1 window). A plugin whose `apiVersion` is below this
 * targets a dropped major and is rejected at boot. See {@link PLUGIN_API_VERSION}.
 *
 * Floored at `1`: there is no major `0`, so at the first major (N = 1) the window
 * collapses to `[1, 1]` rather than admitting a phantom `v0`. Once core reaches
 * major 2 this becomes `1`, opening the genuine N−1 slot.
 */
export const OLDEST_SUPPORTED_API_VERSION = Math.max(1, PLUGIN_API_VERSION - 1);

/**
 * Runtime scope handed to a Tool set factory at Chat-turn time. This SDK is the
 * single home of the type; core re-exports it for its internal callers.
 */
export interface ToolSetContext {
  workspaceId: string;
  agentId: string;
  orgId: string;
  frontendUrl: string | undefined;
  userId: string;
}

/**
 * The logging surface core hands a plugin on {@link PluginConfigContext}. A
 * plugin writes to core's own stream — structured, tagged with the plugin's
 * manifest name, and governed by the Operator's `LOG_LEVEL` — instead of
 * `console.*` or a logging library of its own.
 *
 * Each level takes either a message alone or a fields object with an optional
 * message, mirroring the call shape of the library core logs through. The object
 * form is the one to prefer: its fields stay queryable in the Operator's log
 * pipeline where an interpolated string does not.
 *
 * Deliberately four levels and no `child`. This is the SDK's own hand-written
 * contract, not a re-export of core's logger, so the backing library can change
 * without breaking plugins built against it. More members can arrive later as
 * optional ones under the append-only policy (see {@link PLUGIN_API_VERSION}).
 */
export interface PluginLogger {
  debug(obj: object, msg?: string): void;
  debug(msg: string): void;
  info(obj: object, msg?: string): void;
  info(msg: string): void;
  warn(obj: object, msg?: string): void;
  warn(msg: string): void;
  error(obj: object, msg?: string): void;
  error(msg: string): void;
}

/**
 * Deploy-time, Operator-owned config for one plugin, resolved at boot and
 * injected into **every** one of that plugin's contribution factories (ADR-0013).
 * Keyed by plugin name — the "one config namespace" — and validated at boot
 * against the manifest's plugin-level `configSchema` / `credentialsSchema`.
 *
 * One block is shared across all of a plugin's contributions and all tenants
 * (deployment-wide): a plugin's Sandbox backend and its management Tool set read
 * the same `credentials` here. This is a layer *above* per-Workspace Sandbox
 * config/credentials (ADR-0001/0006); the two layer, they do not merge.
 *
 * `config` / `credentials` are `undefined` when the manifest declares no
 * corresponding schema (nothing to validate against).
 */
export interface PluginConfigContext<
  TConfig = unknown,
  TCredentials = unknown,
> {
  config: TConfig;
  credentials: TCredentials;
  /**
   * A {@link PluginLogger} core binds to this plugin's manifest name, so every
   * line the plugin writes lands in core's stream already attributed and at the
   * verbosity the Operator asked for. Reach for it instead of `console.*`.
   *
   * Optional, and appended (append-only compatibility, ADR-0013) — write
   * `plugin?.logger?.info(...)`. Core always supplies it; the optionality is
   * what keeps a plugin built against an earlier SDK compiling unchanged.
   */
  logger?: PluginLogger;
}

/**
 * The tools a Tool set contributes: either a static map keyed by tool id, or a
 * factory resolved with the {@link ToolSetContext} at Chat-turn time (use the
 * factory when tools need Workspace/Agent scope). Tools are Vercel AI SDK tools.
 *
 * The factory's second argument is the deploy-time {@link PluginConfigContext}
 * — the plugin's shared config/credentials block, the same object handed to
 * every one of the plugin's contribution factories. It is appended and optional
 * so existing single-argument factories keep working unchanged (append-only
 * compatibility, ADR-0013). Core always supplies it at Chat-turn time.
 */
export type ToolSetTools =
  | Record<string, Tool>
  | ((
      ctx: ToolSetContext,
      plugin?: PluginConfigContext,
    ) => Record<string, Tool> | Promise<Record<string, Tool>>);

/**
 * A single Tool set contribution — a named, categorised group of tools an Agent
 * can be granted. This is the payload core's internal `registerToolSet` accepts,
 * with the `id` it takes as its first argument folded in.
 */
export interface ToolSetContribution {
  id: string;
  name: string;
  category: string;
  description?: string;
  tools: ToolSetTools;
}

/**
 * Context handed to every Sandbox adapter call. The (orgId, workspaceId) tuple
 * is the stable identity key for the Sandbox; adapters use it to find or
 * provision their external resource. userId is the Workspace owner, included
 * for audit/identification, not isolation (Workspaces are single-user).
 */
export interface SandboxContext {
  orgId: string;
  workspaceId: string;
  userId: string;
}

/** shell.exec input. All paths are relative to the sandbox workspace root. */
export interface ShellExecInput {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}
export interface ShellExecOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  durationMs: number;
}

export interface FsReadInput {
  path: string;
  lineRange?: [number, number];
}
export interface FsReadOutput {
  content: string;
  lineCount: number;
  truncated: boolean;
}

export interface FsWriteInput {
  path: string;
  content: string;
  mode: "create" | "overwrite";
}
export interface FsWriteOutput {
  bytesWritten: number;
}

export interface FsEditInput {
  path: string;
  oldString: string;
  newString: string;
}
export interface FsEditOutput {
  replacements: 1;
}

export interface FsListInput {
  path?: string;
  recursive?: boolean;
  glob?: string;
}
export interface FsListEntry {
  path: string;
  type: "file" | "dir";
  size?: number;
}
export interface FsListOutput {
  entries: FsListEntry[];
  truncated: boolean;
}

/**
 * Implemented by every Sandbox adapter. Methods take a {@link SandboxContext}
 * plus their typed input and MUST honour the Platypus-defined output bounds,
 * setting the `truncated` flag when they apply them. `destroy()` MUST be
 * idempotent: safe to call on a resource that's already gone.
 *
 * This is append-only within a major API version: new capability arrives as an
 * optional member, never a new required method.
 */
export interface SandboxBackend {
  shellExec(
    ctx: SandboxContext,
    input: ShellExecInput,
  ): Promise<ShellExecOutput>;
  fsRead(ctx: SandboxContext, input: FsReadInput): Promise<FsReadOutput>;
  fsWrite(ctx: SandboxContext, input: FsWriteInput): Promise<FsWriteOutput>;
  fsEdit(ctx: SandboxContext, input: FsEditInput): Promise<FsEditOutput>;
  fsList(ctx: SandboxContext, input: FsListInput): Promise<FsListOutput>;
  destroy(ctx: SandboxContext): Promise<void>;
}

/**
 * A contribution's per-Workspace `configSchema`: either a concrete Zod schema
 * or a **factory** of the plugin's deploy-time config, resolved by the loader at
 * load time into a concrete schema (see {@link SandboxBackendContribution}).
 *
 * The factory form lets a backend derive its per-Workspace validation from
 * Operator-owned plugin config — e.g. `@platypus/docker` closes over the
 * Operator's network allowlist so an out-of-allowlist `networks` entry is
 * rejected at config-save time. This is **append-only** within the major API
 * version: a plain schema stays valid, so backends that don't need plugin config
 * are untouched. Core resolves the factory against the boot-validated {@link
 * PluginConfigContext.config} before the three static `configSchema.safeParse`
 * consumers (save route, teardown, tool resolver) ever see it — they always
 * receive a concrete schema.
 */
export type SandboxConfigSchema<TConfig = unknown> =
  z.ZodType<TConfig> | ((pluginConfig: unknown) => z.ZodType<TConfig>);

/**
 * A single Sandbox-backend contribution — the payload core's internal
 * `registerSandboxBackend` accepts. `backend` is the discriminator stored in the
 * `sandbox.backend` column; `configSchema` / `credentialsSchema` validate the
 * per-Workspace jsonb columns before `create()` instantiates an adapter.
 *
 * `configSchema` may be a plain Zod schema or a {@link SandboxConfigSchema}
 * factory of the plugin's deploy-time config (resolved at load, append-only).
 * The factory receives the boot-validated {@link PluginConfigContext.config} as
 * `unknown` — the same opaque shape `create()`'s `plugin` argument carries — and
 * narrows it itself (a plugin knows its own config schema).
 */
export interface SandboxBackendContribution<
  TConfig = unknown,
  TCredentials = unknown,
> {
  backend: string;
  name: string;
  configSchema: SandboxConfigSchema<TConfig>;
  credentialsSchema: z.ZodType<TCredentials>;
  /**
   * Instantiate the adapter. `config` / `credentials` are the per-Workspace
   * values validated against the schemas above; `plugin` is the deploy-time
   * {@link PluginConfigContext} shared across every one of the plugin's
   * contributions (ADR-0013). `plugin` is appended and optional so existing
   * two-argument factories keep working unchanged (append-only compatibility).
   * Core always supplies it when instantiating the adapter.
   */
  create(
    config: TConfig,
    credentials: TCredentials,
    plugin?: PluginConfigContext,
  ): SandboxBackend;
}

/**
 * Runtime scope handed to a Web-search backend's executor factory at Chat-turn
 * time. Mirrors {@link SandboxContext} deliberately: `userId` is the Workspace
 * owner, carried for audit/attribution, not isolation. No `userEmail` and no
 * signed identity token — a backend that wants to attribute to its *own*
 * upstream does so as its own implementation detail, using its own Plugin
 * credentials (ADR-0014).
 */
export interface WebBackendContext {
  orgId: string;
  workspaceId: string;
  userId: string;
}

/** One search hit. Core caps the count and truncates the strings (ADR-0014). */
export interface WebSearchResult {
  title: string;
  url: string;
  snippet?: string;
}

/**
 * What a `web_search` executor resolves. Structured rather than rendered text so
 * core can cap result counts and the frontend can lift `url` into the Sources
 * row; `answer` is the escape hatch for upstreams with an answer box (Brave,
 * Tavily) so that content is not simply discarded.
 *
 * `query` is part of the shape for symmetry with the model-facing return, but
 * **core echoes the model's own query** in the Tool result — a backend cannot
 * substitute text there.
 */
export interface WebSearchResults {
  query: string;
  results: WebSearchResult[];
  answer?: string;
}

/**
 * What a `read_url` executor resolves. `content` is the page's **full** content:
 * backends never paginate or truncate, because core owns `max_length` /
 * `start_index` slicing and the continuation hint (ADR-0014). `url` is the
 * post-redirect final URL, so the model cites where it actually landed.
 *
 * Casing seam, deliberate: SDK types follow repo camelCase (`contentType`), while
 * the model-facing Tool return is snake_case (`content_type`, `next_start_index`)
 * to mirror `fetchUrl` byte-for-byte — the tool *names* `web_search` / `read_url`
 * are already a documented snake_case exception.
 */
export interface ReadUrlResult {
  content: string;
  url: string;
  contentType?: string;
}

/**
 * The executors a Web-search backend supplies — plain functions, **not** `Tool`s.
 * Core builds the `Tool` objects around these: it owns the input schemas, the
 * model-facing descriptions, result caps, slicing, the per-call timeout, the
 * error contract, and the egress guard on the model-supplied `read_url` URL. A
 * backend that owned the `Tool` would put the model-supplied URL out of core's
 * reach, leaving nowhere to enforce any of that (ADR-0014).
 *
 * `web_search` is mandatory — a Web-search backend that cannot search is
 * meaningless. `read_url` is optional: a search-only Operator (SearXNG, no
 * browser service) omits it and the model simply gets search that turn.
 */
export interface WebBackendExecutors {
  web_search: (input: {
    query: string;
  }) => Promise<WebSearchResults> | WebSearchResults;
  read_url?: (input: { url: string }) => Promise<ReadUrlResult> | ReadUrlResult;
}

/**
 * A single Web-search-backend contribution — the fourth Extension point, filling
 * core's request-gated web-search toggle slot (ADR-0014). `backend` is the
 * discriminator stored in the `provider.searchSource` column (auto-namespaced for
 * third parties, flat for core, per ADR-0013); `name` is the display label shown
 * in the catalog and the Provider selector.
 *
 * There is deliberately **no** per-contribution `configSchema` /
 * `credentialsSchema`: those exist on a Sandbox backend to validate real
 * per-Workspace jsonb columns, and a web backend has no such row — the schema
 * lives where the row lives. A backend's API key and endpoint ride the
 * **plugin-level** schemas via `PLATYPUS_PLUGIN_CONFIG`, boot-validated and
 * injected here as `plugin.credentials`.
 */
export interface WebBackendContribution {
  backend: string;
  name: string;
  /**
   * Timeout applied to {@link createExecutors} **and** to each executor call it
   * returns. Its author knows their upstream — a LAN metasearch should answer in
   * ~2s where a headless-browser render legitimately needs 60 — which is why this
   * is a contribution field and not one global env var. Core defaults to 30000
   * when absent and **refuses at boot** anything above its hard ceiling, so a
   * backend cannot pin a turn open.
   *
   * Budget for the factory, not just the calls: if `createExecutors` does lazy
   * work — a token fetch, a health probe, a browser-pool warm-up — a value tuned
   * only to the search call will time the *factory* out, and the turn then gets no
   * web tools at all (warn-logged; see below). The windows are additive, so the
   * worst case a turn spends inside a backend is `(1 + calls) × timeoutMs`.
   */
  timeoutMs?: number;
  /**
   * Build this backend's executors for one Chat turn. `plugin` is the deploy-time
   * {@link PluginConfigContext} shared across every one of the plugin's
   * contributions (ADR-0013) — where a backend's endpoint and API key live. It is
   * appended and optional so a single-argument factory keeps working unchanged
   * (append-only compatibility); core always supplies it.
   *
   * Boot is fail-loud, runtime is graceful: a contribution that omits this
   * function is rejected at load by plugin name, but a factory that *throws* or
   * outruns {@link timeoutMs} at turn time only costs that turn its web tools —
   * warn-logged, never surfaced to the model, never fatal to the turn. A backend
   * whose tools silently stop appearing is that warn line, not an error.
   */
  createExecutors(
    ctx: WebBackendContext,
    plugin?: PluginConfigContext,
  ): WebBackendExecutors | Promise<WebBackendExecutors>;
}

/**
 * The `contributes` block: keyed by Extension-point type (core-owned, fixed).
 * Adding an Extension point (e.g. a messaging gateway) is a purely additive,
 * minor API bump — a new optional key here.
 */
export interface PluginContributions {
  toolSets?: ToolSetContribution[];
  sandboxBackends?: SandboxBackendContribution[];
  webBackends?: WebBackendContribution[];
}

/**
 * A Platypus plugin manifest. A plugin is a distributable bundle — one version,
 * one config namespace, one enable/disable switch — whose `contributes` block
 * fills core-owned Extension points. Core reads this manifest and drives
 * registration itself; plugin authors never call the internal `register*()`.
 *
 * `configSchema` / `credentialsSchema` describe deploy-time, Operator-owned
 * config keyed by plugin name. Core validates the Operator-supplied values
 * against them at boot (fail-loud on mismatch) and injects the resolved
 * {@link PluginConfigContext} into every contribution factory.
 */
export interface PlatypusPlugin {
  /**
   * The plugin's identity — its config namespace and, for third-party plugins,
   * the prefix core prepends to every contribution id (`${name}.${id}`).
   *
   * This is **distinct from the npm package specifier** an Operator lists in
   * `PLATYPUS_PLUGINS`: a package published as `@acme/platypus-widgets` may set
   * `name: "widgets"`, and its `greeting` tool set then registers as
   * `widgets.greeting`. For a **third-party** plugin `name` MUST be a short,
   * url-safe slug — lowercase letters, digits, and hyphens
   * (`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`) — so the prefixed id stays clean and
   * unambiguous (no `.`, `/`, `@`, or whitespace to muddle the `name.id`
   * boundary or a URL path). Core plugins are exempt: their `@platypus/*` names
   * are logical ids reached through the built-in map and never used as a prefix.
   */
  name: string;
  version: string;
  /**
   * The **minimum** core API major this plugin needs. Core accepts it when it
   * falls in the N-and-N−1 window `[OLDEST_SUPPORTED_API_VERSION,
   * PLUGIN_API_VERSION]`; see {@link PLUGIN_API_VERSION} for the policy.
   */
  apiVersion: number;
  configSchema?: z.ZodType;
  credentialsSchema?: z.ZodType;
  contributes: PluginContributions;
}
