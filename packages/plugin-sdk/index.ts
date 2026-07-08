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
 */
export const OLDEST_SUPPORTED_API_VERSION = PLUGIN_API_VERSION - 1;

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
 * The tools a Tool set contributes: either a static map keyed by tool id, or a
 * factory resolved with the {@link ToolSetContext} at Chat-turn time (use the
 * factory when tools need Workspace/Agent scope). Tools are Vercel AI SDK tools.
 */
export type ToolSetTools =
  | Record<string, Tool>
  | ((
      ctx: ToolSetContext,
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
 * A single Sandbox-backend contribution — the payload core's internal
 * `registerSandboxBackend` accepts. `backend` is the discriminator stored in the
 * `sandbox.backend` column; `configSchema` / `credentialsSchema` validate the
 * per-Workspace jsonb columns before `create()` instantiates an adapter.
 */
export interface SandboxBackendContribution<
  TConfig = unknown,
  TCredentials = unknown,
> {
  backend: string;
  name: string;
  configSchema: z.ZodType<TConfig>;
  credentialsSchema: z.ZodType<TCredentials>;
  create(config: TConfig, credentials: TCredentials): SandboxBackend;
}

/**
 * The `contributes` block: keyed by Extension-point type (core-owned, fixed).
 * Adding an Extension point (e.g. a messaging gateway) is a purely additive,
 * minor API bump — a new optional key here.
 */
export interface PluginContributions {
  toolSets?: ToolSetContribution[];
  sandboxBackends?: SandboxBackendContribution[];
}

/**
 * A Platypus plugin manifest. A plugin is a distributable bundle — one version,
 * one config namespace, one enable/disable switch — whose `contributes` block
 * fills core-owned Extension points. Core reads this manifest and drives
 * registration itself; plugin authors never call the internal `register*()`.
 *
 * `configSchema` / `credentialsSchema` describe deploy-time, Operator-owned
 * config keyed by plugin name; they are part of the locked manifest shape but
 * are not consumed until the plugin-config follow-up slice.
 */
export interface PlatypusPlugin {
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
