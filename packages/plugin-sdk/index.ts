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
 *
 * ## What v2 changed
 *
 * v2 is the first such bump, and it spends the window on one thing: every member
 * core has always supplied unconditionally is now **required** rather than
 * optional. `ToolSetContext.registerCloser`, `WebBackendContext.registerCloser`,
 * `PluginConfigContext.logger` and the trailing `plugin` argument on all three
 * contribution factories were optional only because a v1 manifest could not ask
 * for a core new enough to have them. A v2 manifest can: a v1 core rejects
 * `apiVersion: 2` at boot and names the upgrade, so the guard those members
 * needed — `ctx.registerCloser?.(…)`, `plugin?.logger?.…` — is no longer
 * load-bearing.
 *
 * {@link SandboxConfigSchema}'s factory form is re-signed in the same window: it
 * receives the whole {@link PluginConfigContext} rather than the `config` half
 * alone, so a per-Workspace schema can read the plugin's credentials and write to
 * the plugin's logger like every other factory.
 *
 * Migrating a v1 plugin: set `apiVersion` to 2, drop the `?.` guards, and — if
 * you use the `configSchema` factory form — read `plugin.config` where the
 * argument itself used to be the config.
 *
 * ## What v3 changed
 *
 * The {@link SandboxCallOptions} argument on the five {@link SandboxBackend}
 * tool methods is now **required**. It was optional only because a v2 manifest
 * could still reach a core that never passed it, where an unguarded
 * `options.signal` threw. A v3 manifest is refused by such a core at boot, so
 * the guard is no longer load-bearing. v1 leaves the window: the accepted range
 * is `[2, 3]`, and a v1 plugin is rejected at boot.
 *
 * Migrating a v2 plugin: set `apiVersion` to 3 and drop any `options?.` guard. A
 * v1 plugin migrates through v2 first.
 */
export const PLUGIN_API_VERSION = 3 as const;

/**
 * The oldest plugin API major core still accepts — one below the current major
 * (the "N−1" of the N-and-N−1 window). A plugin whose `apiVersion` is below this
 * targets a dropped major and is rejected at boot. See {@link PLUGIN_API_VERSION}.
 */
export const OLDEST_SUPPORTED_API_VERSION = PLUGIN_API_VERSION - 1;

/**
 * Hand core something to close when the Chat turn ends.
 *
 * The one capability a Contribution's runtime context carries. A factory that
 * opens something with a lifetime — a browser page, a connection pool, a
 * keep-alive socket — registers its close here and core runs it once, on the
 * turn's normal finish and on the User cancelling alike.
 *
 * Rules core holds you to, so nothing you register can cost the turn:
 *
 * - **Called once.** The same function registered twice *in one turn* closes
 *   once, and a second `dispose` of the same turn closes nothing again. Nothing
 *   is deduped across turns — each turn owns what it registered — so register
 *   what this turn opened rather than something you mean to keep between them.
 * - **A throw is logged, not propagated.** The closers after yours still run.
 * - **Bounded.** A closer that never settles is abandoned after a few seconds so
 *   it cannot delay the run's terminal write; treat it as a hint to give your own
 *   teardown a deadline rather than as a budget to spend.
 * - **Late registration still closes.** Registering after the turn was already
 *   torn down (a delegate unwinding under an abort) closes immediately.
 */
export type CloserRegistrar = (close: () => Promise<void> | void) => void;

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
  /**
   * Register something to close when this turn ends — see
   * {@link CloserRegistrar}.
   *
   * **Required as of API v2** (see {@link PLUGIN_API_VERSION}), and core has
   * always supplied it. Call it directly — `ctx.registerCloser(close)`. It was
   * optional through v1 for one reason: a v1 manifest could not ask for a core
   * new enough to have the member, so on an older core it was genuinely absent
   * and an unguarded call threw out of the factory, costing the turn every tool
   * in this set. A v2 manifest cannot reach such a core — it is refused at boot —
   * so the guard has nothing left to protect against.
   */
  registerCloser: CloserRegistrar;
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
   * **Required as of API v2** (see {@link PLUGIN_API_VERSION}), and core has
   * always supplied it — write `plugin.logger.info(...)` rather than the doubly
   * guarded `plugin?.logger?.info(...)` a v1 plugin had to.
   */
  logger: PluginLogger;
}

/**
 * The tools a Tool set contributes: either a static map keyed by tool id, or a
 * factory resolved with the {@link ToolSetContext} at Chat-turn time (use the
 * factory when tools need Workspace/Agent scope). Tools are Vercel AI SDK tools.
 *
 * The factory's second argument is the deploy-time {@link PluginConfigContext}
 * — the plugin's shared config/credentials block, the same object handed to
 * every one of the plugin's contribution factories. **Required as of API v2**
 * (see {@link PLUGIN_API_VERSION}), which costs a single-argument factory
 * nothing: TypeScript lets a function ignore arguments it is passed, so
 * `(ctx) => …` still satisfies this type. What it buys a factory that *does*
 * read the block is a value that is never `undefined`.
 *
 * Write **bare** tool names. For a third-party plugin core namespaces each one
 * under the manifest {@link PlatypusPlugin.name} before the model sees it, so
 * `createIssue` in a plugin named `widgets` is called as
 * `widgets__createIssue`. A tool name is capped at 32 characters: one declared
 * in a static map over the cap fails boot, and one a factory resolves over the
 * cap is left out of that turn with a warning. Neither is truncated to fit.
 * Core plugins keep bare tool names, as they keep bare ids.
 */
export type ToolSetTools =
  | Record<string, Tool>
  | ((
      ctx: ToolSetContext,
      plugin: PluginConfigContext,
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
 * The largest file Platypus moves through {@link SandboxBackend.fsReadBytes} or
 * {@link SandboxBackend.fsWriteBytes}, in either direction, on every backend:
 * 25 MiB. Fixed — neither an adapter nor an Operator can change it.
 */
export const SANDBOX_TRANSFER_MAX_BYTES = 25 * 1024 * 1024;

export interface FsReadBytesInput {
  path: string;
  /** Reject rather than return a file larger than this. */
  maxBytes: number;
}

export interface FsWriteBytesInput {
  path: string;
  bytes: Uint8Array;
}

/**
 * The per-call options a Sandbox backend's tool methods are handed as an
 * appended third argument, mirroring {@link WebExecutorOptions}.
 *
 * `signal` fires when core stops waiting for this call: the person in the Chat
 * pressed stop, or the run hit its per-step or per-run timeout. Honour it where
 * the work actually happens — kill the command, close the channel — and the
 * work stops with the turn instead of running on as an orphan.
 *
 * **Required as of API v3** (see {@link PLUGIN_API_VERSION}): core passes it on
 * every call, so read `options.signal` unguarded. **Honouring it is still your
 * choice.** A backend that ignores it behaves exactly as every adapter did
 * before this parameter existed: core stops waiting either way, so the turn is
 * never held open by a call that does not come back.
 *
 * Named for the call, not for `SandboxExecOptions` — that is core's *internal*
 * per-command shape (`timeoutMs`, output caps) beneath the POSIX transport
 * seam, and nothing an adapter implementing this interface ever sees.
 */
export interface SandboxCallOptions {
  signal: AbortSignal;
}

/**
 * Implemented by every Sandbox adapter. Methods take a {@link SandboxContext}
 * plus their typed input and MUST honour the Platypus-defined output bounds,
 * setting the `truncated` flag when they apply them. `destroy()` MUST be
 * idempotent: safe to call on a resource that's already gone.
 *
 * This is append-only within a major API version: new capability arrives as an
 * optional member, never a new required method.
 *
 * The five tool methods take {@link SandboxCallOptions} as a **required**
 * appended argument (as of API v3), on the same terms the Web-search executors
 * do. An adapter written before it existed declares two parameters, still
 * satisfies this interface, and still works.
 */
export interface SandboxBackend {
  shellExec(
    ctx: SandboxContext,
    input: ShellExecInput,
    options: SandboxCallOptions,
  ): Promise<ShellExecOutput>;
  fsRead(
    ctx: SandboxContext,
    input: FsReadInput,
    options: SandboxCallOptions,
  ): Promise<FsReadOutput>;
  fsWrite(
    ctx: SandboxContext,
    input: FsWriteInput,
    options: SandboxCallOptions,
  ): Promise<FsWriteOutput>;
  fsEdit(
    ctx: SandboxContext,
    input: FsEditInput,
    options: SandboxCallOptions,
  ): Promise<FsEditOutput>;
  fsList(
    ctx: SandboxContext,
    input: FsListInput,
    options: SandboxCallOptions,
  ): Promise<FsListOutput>;
  /**
   * Read a whole file, byte-exact — no decoding. Not a Tool: the bytes go to
   * the User, never into model context, so the five tools' caps do not apply.
   *
   * Reject when the file is larger than `maxBytes` (you need not pull it across
   * to find out), and when `path` is missing or is not a readable file.
   *
   * Optional. Implement it only if you can read any file up to {@link
   * SANDBOX_TRANSFER_MAX_BYTES}; a transport with a smaller limit chunks
   * internally. A backend that leaves it out offers no downloads — Platypus has
   * no fallback through the five tools.
   */
  fsReadBytes?(
    ctx: SandboxContext,
    input: FsReadBytesInput,
    options: SandboxCallOptions,
  ): Promise<Uint8Array>;
  /**
   * Write a whole file, byte-exact. **Always overwrites** whatever is at
   * `path`, and creates missing parent directories — Platypus decides
   * create-versus-overwrite before calling. Not a Tool.
   *
   * Optional, on the same terms as {@link SandboxBackend.fsReadBytes}: handle
   * any file up to {@link SANDBOX_TRANSFER_MAX_BYTES} or leave it out, in which
   * case the backend offers no uploads. The two are gated independently.
   */
  fsWriteBytes?(
    ctx: SandboxContext,
    input: FsWriteBytesInput,
    options: SandboxCallOptions,
  ): Promise<void>;
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
 * rejected at config-save time. A plain schema stays valid, so backends that
 * don't need plugin config are untouched. Core resolves the factory before the
 * three static `configSchema.safeParse` consumers (save route, teardown, tool
 * resolver) ever see it — they always receive a concrete schema.
 *
 * **Re-signed in API v2** (see {@link PLUGIN_API_VERSION}): the factory receives
 * the whole {@link PluginConfigContext}, where through v1 it received the
 * `config` half alone, as `unknown`. It was the one factory in this SDK that
 * could reach neither the plugin's credentials nor its logger — so the one
 * factory with no way to say *why* it refused a value. A v1 factory migrates by
 * reading `plugin.config` where its argument used to be the config itself.
 */
export type SandboxConfigSchema<TConfig = unknown> =
  z.ZodType<TConfig> | ((plugin: PluginConfigContext) => z.ZodType<TConfig>);

/**
 * A single Sandbox-backend contribution — the payload core's internal
 * `registerSandboxBackend` accepts. `backend` is the discriminator stored in the
 * `sandbox.backend` column; `configSchema` / `credentialsSchema` validate the
 * per-Workspace jsonb columns before `create()` instantiates an adapter.
 *
 * `configSchema` may be a plain Zod schema or a {@link SandboxConfigSchema}
 * factory of the plugin's deploy-time block (resolved at load). The factory
 * receives the same {@link PluginConfigContext} `create()` does, and narrows
 * `config` / `credentials` itself — a plugin knows its own schemas.
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
   * contributions (ADR-0013). **Required as of API v2** (see {@link
   * PLUGIN_API_VERSION}), which costs a two-argument `create` nothing — it still
   * satisfies this type — and gives one that reads the block a value that is
   * never `undefined`.
   */
  create(
    config: TConfig,
    credentials: TCredentials,
    plugin: PluginConfigContext,
  ): SandboxBackend;
}

/**
 * Runtime scope handed to a Web-search backend's executor factory at Chat-turn
 * time. Mirrors {@link SandboxContext} deliberately: `userId` is the Workspace
 * owner, carried for audit/attribution, not isolation. No `userEmail` and no
 * signed identity token — a backend that wants to attribute to its *own*
 * upstream does so as its own implementation detail, using its own Plugin
 * credentials (ADR-0014).
 *
 * Not plain data: it carries exactly one capability, `registerCloser`.
 * Everything else on it is still a value to read.
 */
export interface WebBackendContext {
  orgId: string;
  workspaceId: string;
  userId: string;
  /**
   * Register something to close when this turn ends — see
   * {@link CloserRegistrar}. This is where a browser pool or a keep-alive
   * connection opened by `createExecutors` gets released.
   *
   * **Required as of API v2** (see {@link PLUGIN_API_VERSION}), and core has
   * always supplied it. Call it directly — `ctx.registerCloser(close)`. It was
   * optional through v1 for one reason: a v1 manifest could not ask for a core
   * new enough to have the member, so on an older core it was genuinely absent
   * and an unguarded call threw out of `createExecutors`, costing the turn its
   * search tools entirely. A v2 manifest cannot reach such a core.
   */
  registerCloser: CloserRegistrar;
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
 * The second argument core passes every executor call.
 *
 * `signal`, not `abortSignal`, because what a backend does with it is
 * `fetch(url, { signal })`.
 *
 * Reading it is optional — an existing single-argument executor keeps compiling
 * and keeps working, because appending a parameter core supplies breaks nothing
 * (append-only compatibility, ADR-0013). Honour it and your upstream request
 * stops when it fires; ignore it and you get the historical behaviour, where
 * core stops waiting and your call runs on until its own socket timeout.
 *
 * It fires for **either** reason: the User cancelled the turn, or the
 * contribution's own `timeoutMs` deadline passed. A backend has no reason to
 * tell the two apart — both mean core is no longer waiting for this call — so
 * they arrive as one signal.
 */
export interface WebExecutorOptions {
  signal: AbortSignal;
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
 *
 * Both take {@link WebExecutorOptions} as an appended second argument, carrying
 * the signal for the call. Consume it or don't; core supplies it either way.
 */
export interface WebBackendExecutors {
  web_search: (
    input: { query: string },
    options: WebExecutorOptions,
  ) => Promise<WebSearchResults> | WebSearchResults;
  read_url?: (
    input: { url: string },
    options: WebExecutorOptions,
  ) => Promise<ReadUrlResult> | ReadUrlResult;
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
 * **plugin-level** schemas via `PLATYPUS_PLUGIN_CONFIG_<NAME>`, boot-validated and
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
   * contributions (ADR-0013) — where a backend's endpoint and API key live.
   * **Required as of API v2** (see {@link PLUGIN_API_VERSION}), which costs a
   * single-argument factory nothing — it still satisfies this type — and gives
   * one that reads the block a value that is never `undefined`.
   *
   * Boot is fail-loud, runtime is graceful: a contribution that omits this
   * function is rejected at load by plugin name, but a factory that *throws* or
   * outruns {@link timeoutMs} at turn time only costs that turn its web tools —
   * warn-logged, never surfaced to the model, never fatal to the turn. A backend
   * whose tools silently stop appearing is that warn line, not an error.
   */
  createExecutors(
    ctx: WebBackendContext,
    plugin: PluginConfigContext,
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
   * the prefix core prepends to every contribution id (`${name}.${id}`) and to
   * every tool name its Tool sets contribute (`${name}__${toolName}`).
   *
   * This is **distinct from the npm package specifier** an Operator lists in
   * `PLATYPUS_PLUGINS`: a package published as `@acme/platypus-widgets` may set
   * `name: "widgets"`, and its `greeting` tool set then registers as
   * `widgets.greeting`. For a **third-party** plugin `name` MUST be a short,
   * url-safe slug — lowercase letters, digits, and hyphens
   * (`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`) — so the prefixed id stays clean and
   * unambiguous (no `.`, `/`, `@`, or whitespace to muddle the `name.id`
   * boundary or a URL path), and at most **24 characters**, so the composed tool
   * name stays inside what a model provider allows. Both are refused at boot.
   * Core plugins are exempt: their `@platypus/*` names are logical ids reached
   * through the built-in map and never used as a prefix.
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
