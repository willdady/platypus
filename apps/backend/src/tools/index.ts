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
import {
  MAX_PLUGIN_TOOL_NAME_LENGTH,
  namespaceToolName,
  TOOL_NAME_PATTERN,
} from "@platypus/schemas";
import { RESERVED_TURN_TOOL_NAMES } from "./turn-tool-names.ts";

// The Extension-point surface lives in the published SDK; re-export the context
// type so core's internal callers keep importing it from here.
export type { ToolSetContext } from "@platypuschat/plugin-sdk";
import type {
  PluginConfigContext,
  ToolSetContext,
  ToolSetContribution,
} from "@platypuschat/plugin-sdk";
import { withAttributedRegistrar, type WithCoreRegistrar } from "./closers.ts";

/**
 * The context core builds for a Tool set factory: the published shape, but
 * carrying core's own registrar, which takes the attribution a log line needs
 * (see `./closers.ts`). Assignable to `ToolSetContext`, so what a Contribution is
 * handed is still the published shape.
 */
export type CoreToolSetContext = WithCoreRegistrar<ToolSetContext>;

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
  /**
   * The owning MCP's tool-namespace slug (issue #467), so a collision or
   * exclusion log names an MCP an Operator recognises rather than only its
   * internal id. `undefined` for anything that is not an MCP.
   */
  mcpSlug?: string;
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
    context: CoreToolSetContext,
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
        // Only ever set on the MCP branch — an Operator debugging a shadowed
        // tool then sees the MCP by the name they gave it, not just its id.
        mcpSlug: owner.mcpSlug,
        shadowedToolSet: incumbent.toolSetId,
        shadowedPlugin: incumbent.plugin,
        shadowedMcpSlug: incumbent.mcpSlug,
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
  /**
   * Owning plugin's manifest name, for attribution in every log line — and, for
   * a third-party plugin, the namespace its tool names enter a turn under.
   */
  pluginName: string;
  /**
   * Whether the owning plugin is a core built-in. Decides the tool-name rule
   * below the same way it already decides the contribution-id rule: core bare,
   * third-party prefixed.
   *
   * Carried from the loader, which is the sole authority on origin (membership of
   * the built-in map), rather than inferred here by comparing {@link pluginName}
   * against a core sentinel — a plugin that borrowed the sentinel string would
   * then buy itself bare tool names.
   */
  isCore: boolean;
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
 *
 * A Tool set now has a *lifetime* hook without having a *budget* — the factory
 * may register a closer through `ctx.registerCloser`, and that closer is bounded
 * even though the factory that registered it is not. The asymmetry is deliberate,
 * not an oversight to tidy up: teardown runs while a reader waits on the run's
 * terminal write, so it needs a ceiling core can pick; the factory's ceiling is a
 * number only the author knows, and `ToolSetContribution` has nowhere to say it.
 */
export const composeToolSet = (
  options: ComposeToolSetOptions,
): ToolSetRegistration => {
  const { contribution, id, plugin, pluginName, isCore } = options;
  const { name, category, description, tools } = contribution;

  /**
   * Why `toolName` cannot enter a turn under this plugin's namespace, or `null`
   * if it can. Third-party only — a core Tool set is not namespaced, so neither
   * bound applies to it.
   *
   * `reason` is phrased for an author and never quotes the regex: the rule an
   * author has to satisfy is a sentence, not a pattern. `bindings` are the
   * structured fields for the log line, and they differ per fault on purpose —
   * reporting `cap` and `length` on a charset fault would tell an Operator the
   * wrong reason while the message said the right one.
   *
   * Two bounds, because they say different things: the cap is the documented
   * limit an author is held to, and the pattern is the model-provider ceiling
   * that catches a character the cap says nothing about. Neither is a
   * total-length check — the manifest-name cap the loader enforces and the cap
   * here bound the composed name by arithmetic, so the pattern's own `{1,64}` is
   * unreachable and only its character set can fire.
   */
  const toolNameFault = (
    toolName: string,
  ): { reason: string; bindings: Record<string, string | number> } | null => {
    if (toolName.length > MAX_PLUGIN_TOOL_NAME_LENGTH) {
      return {
        reason: `its name is ${toolName.length} characters, over the ${MAX_PLUGIN_TOOL_NAME_LENGTH}-character cap for a third-party tool name. Rename the tool shorter`,
        bindings: {
          cap: MAX_PLUGIN_TOOL_NAME_LENGTH,
          length: toolName.length,
        },
      };
    }
    const namespaced = namespaceToolName(pluginName, toolName);
    if (!TOOL_NAME_PATTERN.test(namespaced)) {
      return {
        reason: `namespaced as "${namespaced}" it is not a callable tool name — a tool name may use only letters, digits, underscores and hyphens. Rename the tool`,
        bindings: { namespacedName: namespaced },
      };
    }
    return null;
  };

  /**
   * Every tool a third-party Tool set contributes enters the turn as
   * `<manifest-name>__<toolName>` (issue #664) — unconditionally, not only on
   * collision, so a name never depends on load order. Core Tool sets keep their
   * bare names, exactly as core contribution ids do.
   *
   * A name over the cap is excluded and reported, never truncated to fit: two
   * long names from one Tool set could truncate onto each other and reintroduce
   * the very collision this removes, invisibly. A static map's names are known at
   * boot and fail there instead (see {@link namespaceStaticToolsOrThrow} below),
   * so the exclusion is only reachable for a factory.
   */
  const namespaceToolNames = (
    turnTools: Record<string, Tool>,
  ): Record<string, Tool> => {
    if (isCore) return turnTools;
    const namespaced: Record<string, Tool> = {};
    for (const [toolName, entry] of Object.entries(turnTools)) {
      const fault = toolNameFault(toolName);
      if (fault) {
        logger.warn(
          {
            plugin: pluginName,
            toolSet: id,
            tool: toolName,
            ...fault.bindings,
          },
          `Tool set's tool cannot enter a turn: ${fault.reason}. Excluding it from this turn.`,
        );
        continue;
      }
      namespaced[namespaceToolName(pluginName, toolName)] = entry;
    }
    return namespaced;
  };

  /**
   * The static map as the catalogs should list it — namespaced — or a throw.
   *
   * A static map's names are known at boot, so a name core cannot serve fails
   * there rather than going missing from a turn: fail-loud per ADR-0013, naming
   * the plugin the way every other Tool-set boot error does. One pass, so the
   * names are checked exactly where they are rewritten.
   *
   * The two origins fail on opposite rules. A third-party name is held to the
   * cap and the ceiling, because it is about to be namespaced. A core name is
   * held to neither and is instead refused if it takes one of the four names core
   * assigns to a turn after the Tool session — the residual case namespacing
   * leaves behind, since a core set's names stay bare.
   */
  const namespaceStaticToolsOrThrow = (
    declared: Record<string, Tool>,
  ): Record<string, Tool> => {
    const namespaced: Record<string, Tool> = {};
    for (const [toolName, entry] of Object.entries(declared)) {
      if (isCore) {
        if (RESERVED_TURN_TOOL_NAMES.includes(toolName)) {
          throw new Error(
            `Plugin "${pluginName}": tool set "${id}" declares a tool named "${toolName}", which core assigns to every turn that has it. A core tool set's names are not namespaced, so this one would be overwritten with nothing said. Rename the tool.`,
          );
        }
        namespaced[toolName] = entry;
        continue;
      }
      const fault = toolNameFault(toolName);
      if (fault) {
        throw new Error(
          `Plugin "${pluginName}": tool set "${id}" declares a tool "${toolName}" that cannot enter a turn: ${fault.reason}.`,
        );
      }
      namespaced[namespaceToolName(pluginName, toolName)] = entry;
    }
    return namespaced;
  };

  const staticTools = typeof tools === "function" ? undefined : tools;
  // Boot-time: throws here, inside `composeToolSet`, because the loader calls it
  // at boot and a throw from a `prepare` is how every other Tool-set fault
  // aborts startup.
  const namespacedStaticTools = staticTools
    ? namespaceStaticToolsOrThrow(staticTools)
    : undefined;

  const buildTurnTools = async (
    context: CoreToolSetContext,
    claimed?: ReadonlyMap<string, ToolOwner>,
  ): Promise<Record<string, Tool>> => {
    let resolved: unknown = tools;
    if (typeof tools === "function") {
      // The *context* is derived so a closer this factory registers is logged
      // against the plugin and Tool set that registered it. The **contribution**
      // is still called untouched — that invariant is about `this`, not `ctx`.
      const ctx: ToolSetContext = withAttributedRegistrar(context, {
        plugin: pluginName,
        toolSet: id,
      });
      try {
        resolved = await tools(ctx, plugin);
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

    // Namespaced after per-tool result normalization and before the tools are
    // collision-reported and claimed, so ownership keying and collision
    // reporting both see the final name — the only name the model, the
    // Transcript, and a second Tool set can contest.
    const turnTools = namespaceToolNames(
      normalizeToolResults(resolved as Record<string, Tool>),
    );
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
    // Namespaced: `staticTools` backs the Tool-set listing endpoints, and a
    // listing has to show the names the model will actually call.
    ...(namespacedStaticTools ? { staticTools: namespacedStaticTools } : {}),
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
    isCore: true,
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
