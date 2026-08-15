import { type Tool } from "ai";
import { eq } from "drizzle-orm";
import { db } from "../index.ts";
import { sandbox as sandboxTable } from "../db/schema.ts";
import { getSandboxBackend } from "../sandbox/index.ts";
import {
  CORE_BUILTIN_OWNER,
  getSandboxBackendPlugin,
} from "../plugins/registry.ts";
import { createContributionRegistry } from "../registry/contribution-registry.ts";
import { createSandboxTools } from "../sandbox/tools.ts";
import { normalizeToolResults } from "../services/tool-result.ts";
import { logger } from "../logger.ts";

// The Extension-point surface lives in the published SDK; re-export the context
// type so core's internal callers keep importing it from here.
export type { ToolSetContext } from "@platypuschat/plugin-sdk";
import type {
  PluginConfigContext,
  ToolSetContext,
  ToolSetContribution,
} from "@platypuschat/plugin-sdk";

/**
 * Who put a tool name into a turn's tool map. Carried alongside the map so a
 * collision can name the Tool set that lost the name *and* the plugin that owns
 * it — an Operator debugging a shadowed tool has neither otherwise.
 */
export type ToolOwner = {
  /** The Tool set the tool came from, or the MCP id on the MCP branch. */
  toolSetId: string;
  /**
   * The contributing plugin's manifest name (or {@link CORE_BUILTIN_OWNER} for a
   * core registration), and `null` for tools that came from an MCP server, which
   * belongs to no plugin.
   */
  plugin: string | null;
};

/**
 * What the Tool-set registry stores: identity for the catalogs, plus core's
 * *composed* per-turn builder — never the contribution's raw `tools`. The same
 * shape the Web-search-backend registry holds (ADR-0014), for the same reason:
 * everything between a plugin's factory and the model is core's, so there is one
 * place that owns it rather than one per caller.
 */
export type ToolSetRegistration = {
  id: string;
  name: string;
  category: string;
  description?: string;
  /**
   * This Tool set's model-facing Tools for one Chat turn — resolved, guarded,
   * and result-normalized. Never rejects: a Tool set that cannot serve this turn
   * contributes no tools instead of failing it.
   *
   * `claimed` is the turn's accumulating tool map as it stands, so a name this
   * Tool set is about to take from an earlier one is reported rather than
   * silently swapped. Optional: a caller resolving a single Tool set in
   * isolation has no turn map to compare against.
   */
  buildTurnTools: (
    context: ToolSetContext,
    claimed?: ReadonlyMap<string, ToolOwner>,
  ) => Promise<Record<string, Tool>>;
  /**
   * The contribution's tools when it declared them as a static map, for the
   * catalogs that name individual tools ahead of any turn. Undefined for a
   * factory: what it serves depends on the Workspace, so only a turn can say.
   */
  staticTools?: Record<string, Tool>;
};

// The Tool-set instance of the shared Extension-point registry — same store,
// same miss semantics, and same duplicate-id error as the Sandbox and Web-search
// backend registries.
const TOOL_SETS = createContributionRegistry<ToolSetRegistration>({
  noun: "Tool set",
});

export const registerToolSet = (
  toolSetId: string,
  registration: Omit<ToolSetRegistration, "id">,
): ToolSetRegistration =>
  TOOL_SETS.register(toolSetId, { ...registration, id: toolSetId });

/** The Tool set registered under `toolSetId`, or `undefined` if none is. */
export const getToolSet = (
  toolSetId: string,
): ToolSetRegistration | undefined => TOOL_SETS.get(toolSetId);

/** Whether `toolSetId` names a statically-registered Tool set. */
export const hasToolSet = (toolSetId: string): boolean =>
  TOOL_SETS.has(toolSetId);

/** Every registered Tool set, in registration order. Each carries its own id. */
export const getToolSets = (): readonly ToolSetRegistration[] =>
  TOOL_SETS.list();

/**
 * Warn for every name `incoming` takes from a Tool set that already claimed it
 * this turn.
 *
 * The later contributor wins, as it always has — assignment order is the
 * precedence order a Chat turn is built on. What changes is that the swap is
 * now on the record: an Agent granted two Tool sets that both define `search`
 * used to serve one of them with no trace of the other, and which one depended
 * on the order the ids happen to sit in on the Agent row.
 */
export const reportToolNameCollisions = (
  incoming: Record<string, Tool>,
  claimed: ReadonlyMap<string, ToolOwner> | undefined,
  owner: ToolOwner,
): void => {
  if (!claimed || claimed.size === 0) return;
  for (const tool of Object.keys(incoming)) {
    const incumbent = claimed.get(tool);
    if (!incumbent) continue;
    logger.warn(
      {
        tool,
        toolSet: owner.toolSetId,
        plugin: owner.plugin,
        shadowedToolSet: incumbent.toolSetId,
        shadowedPlugin: incumbent.plugin,
      },
      "Two tool sets contribute the same tool name; the later one wins this turn",
    );
  }
};

export interface ComposeToolSetOptions {
  /**
   * The contribution exactly as its author wrote it. Its `tools` factory is
   * called on this object — never on a copy — so a class-instance contribution
   * keeps its prototype and its `this`. The namespaced id rides {@link id}.
   */
  contribution: Omit<ToolSetContribution, "id">;
  /** The id this Tool set registers under (namespaced, for a third-party plugin). */
  id: string;
  /** The plugin's boot-resolved deploy-time config/credentials (ADR-0013). */
  plugin?: PluginConfigContext;
  /** Owning plugin's manifest name, for attribution in every log line. */
  pluginName: string;
}

/**
 * Wrap one Tool-set contribution into the registration core stores.
 *
 * This is where core takes ownership of everything between a plugin's factory
 * and the model: the deploy-time config binding, catch-and-degrade on the
 * factory, per-tool result normalization, and collision reporting against the
 * turn's tool map.
 *
 * Boot stays fail-loud and runtime resolution stays graceful (ADR-0013): a
 * factory that throws costs the turn this Tool set's tools, not the turn — the
 * posture the Web-search point already takes, and the one the MCP branch of a
 * Tool session has always taken for an unreachable server.
 *
 * No timeout, unlike a Web-search backend's executors: `ToolSetContribution`
 * declares no per-call budget, and the factories in the field legitimately reach
 * the database and a Sandbox backend on the way to building their tools. A
 * hanging factory still pins the turn open; a ceiling for that belongs on the
 * contribution, where an author can state it.
 */
export const composeToolSet = (
  options: ComposeToolSetOptions,
): ToolSetRegistration => {
  const { contribution, id, plugin, pluginName } = options;
  const { name, category, description, tools } = contribution;

  const buildTurnTools = async (
    context: ToolSetContext,
    claimed?: ReadonlyMap<string, ToolOwner>,
  ): Promise<Record<string, Tool>> => {
    let resolved: unknown = tools;
    if (typeof tools === "function") {
      try {
        resolved = await tools(context, plugin);
      } catch (cause) {
        logger.warn(
          {
            plugin: pluginName,
            toolSet: id,
            orgId: context.orgId,
            workspaceId: context.workspaceId,
            agentId: context.agentId,
            cause,
          },
          "Tool set factory threw; serving none of its tools this turn",
        );
        return {};
      }
    }

    // The TS type makes `tools` a map or a factory returning one; a third-party
    // *JS* plugin can return anything, and `Object.assign(turn, "oops")` spreads
    // a string's indices into the turn's tool map rather than failing.
    if (
      typeof resolved !== "object" ||
      resolved === null ||
      Array.isArray(resolved)
    ) {
      logger.warn(
        { plugin: pluginName, toolSet: id },
        "Tool set resolved to no tool map; serving none of its tools this turn",
      );
      return {};
    }

    const turnTools = normalizeToolResults(resolved as Record<string, Tool>);
    reportToolNameCollisions(turnTools, claimed, {
      toolSetId: id,
      plugin: pluginName,
    });
    return turnTools;
  };

  return {
    id,
    name,
    category,
    description,
    buildTurnTools,
    ...(typeof tools === "function" ? {} : { staticTools: tools }),
  };
};

// Tool set ID constants for referencing registered tool sets by name
export const MEMORY_TOOLSET_ID = "memory";

// REGISTER TOOL SETS HERE!
// Note: the native Tool sets now ship as core plugins loaded via the plugin
// loader from `PLATYPUS_PLUGINS` (see ADR-0013) — `math-conversions`/`time` as
// `@platypus/tools-basic`, `web-fetch` as `@platypus/web-fetch`, and the
// Platypus-domain sets (kanban, dashboards, triggers, agent-discovery,
// skill-management, agent-management, notifications, memory) as
// `@platypus/tools-platform`. Their factories live in `./*.ts`; the manifests
// live under `apps/backend/src/plugins/`.
//
// The `sandbox` Tool set below is the lone exception: it is the consumer side of
// the Sandbox-backend extension point (ADR-0002) rather than a native Tool set,
// so it stays a core-internal static registration here. It resolves at chat-turn
// time: load the Workspace's sandbox row, look up the registered adapter,
// validate config/credentials, then build the five AI SDK Tools. Missing-row,
// unregistered-backend, and
// validation failures all degrade gracefully to "no tools this turn" (with a
// warning log). See ADR-0001 / ADR-0002.
export const SANDBOX_TOOLSET_ID = "sandbox";

// Registered through `composeToolSet` like every plugin contribution — a core
// built-in is a Tool set on the same terms, and its factory reads a row and
// builds an adapter's tools, so it earns the same guard.
registerToolSet(
  SANDBOX_TOOLSET_ID,
  composeToolSet({
    id: SANDBOX_TOOLSET_ID,
    pluginName: CORE_BUILTIN_OWNER,
    contribution: {
      name: "Sandbox",
      category: "Sandbox",
      description:
        "Shell and filesystem access inside the workspace's configured sandbox",
      tools: async ({ workspaceId, orgId, userId }) => {
        const rows = await db
          .select()
          .from(sandboxTable)
          .where(eq(sandboxTable.workspaceId, workspaceId))
          .limit(1);
        if (rows.length === 0) return {};

        const row = rows[0];
        // Every line below is core's, but the subject of all three is a *plugin's*
        // adapter, so each binds the owning plugin under the same `plugin` key the
        // plugin's own lines carry. Otherwise an Operator filtering on one plugin
        // gets the adapter's own lines and none of core's about it. `null` rather
        // than absent when the backend belongs to no loaded plugin — the first case
        // below is exactly that, and "no owner" is the answer, not "unasked".
        const plugin = getSandboxBackendPlugin(row.backend) ?? null;
        const registration = getSandboxBackend(row.backend);
        if (!registration) {
          logger.warn(
            { backend: row.backend, plugin, sandboxId: row.id },
            "Sandbox backend not registered; skipping sandbox tools for this turn",
          );
          return {};
        }

        const configResult = registration.configSchema.safeParse(
          row.config ?? {},
        );
        if (!configResult.success) {
          logger.warn(
            {
              backend: row.backend,
              plugin,
              sandboxId: row.id,
              issues: configResult.error.issues,
            },
            "Sandbox config failed adapter validation; skipping sandbox tools",
          );
          return {};
        }

        const credentialsResult = registration.credentialsSchema.safeParse(
          row.credentials ?? {},
        );
        if (!credentialsResult.success) {
          logger.warn(
            {
              backend: row.backend,
              plugin,
              sandboxId: row.id,
              issues: credentialsResult.error.issues,
            },
            "Sandbox credentials failed adapter validation; skipping sandbox tools",
          );
          return {};
        }

        const backend = registration.create(
          configResult.data,
          credentialsResult.data,
        );
        // Two-tier env (ADR-0004 amendment, ADR-0006): adminEnv wins over userEnv.
        // The combined map is then merged over the model-provided input.env inside
        // createSandboxTools (workspace wins), giving the full precedence order
        // adminEnv ▸ userEnv ▸ input.env.
        const workspaceEnv = {
          ...(row.userEnv ?? {}),
          ...(row.adminEnv ?? {}),
        };
        return createSandboxTools(
          backend,
          { orgId, workspaceId, userId },
          workspaceEnv,
        );
      },
    },
  }),
);
