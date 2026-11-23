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
import { createSandboxTools, type ModelFileReading } from "../sandbox/tools.ts";
import { resolveScoped } from "../services/scoped-resource.ts";
import {
  maxExtractedTextCharsForModel,
  passthroughFileTypesForModel,
  resolveModelId,
} from "../services/model-capability.ts";
import { normalizeToolResults } from "../services/tool-result.ts";
import { logger } from "../logger.ts";
import {
  DEFAULT_MAX_EXTRACTED_TEXT_CHARS,
  MAX_PLUGIN_TOOL_NAME_LENGTH,
  namespaceToolName,
  TOOL_NAME_PATTERN,
} from "@platypus/schemas";
import { RESERVED_TURN_TOOL_NAMES } from "./turn-tool-names.ts";

export type { ToolSetContext } from "@platypuschat/plugin-sdk";
import type {
  PluginConfigContext,
  ToolSetContext,
  ToolSetContribution,
} from "@platypuschat/plugin-sdk";
import { withAttributedRegistrar, type WithCoreRegistrar } from "./closers.ts";
import {
  CallerAbortedError,
  DeadlineExceededError,
  withDeadline,
} from "../utils/abort-race.ts";
import { isRecord } from "../utils/is-record.ts";

// why: well inside the run's 2-minute step timer, so a hung MCP server can't time the step out
export const TOOL_SET_RESOLVE_TIMEOUT_MS = 20_000;

export type CoreToolSetContext = WithCoreRegistrar<ToolSetContext>;

export type ToolOwner = {
  toolSetId: string;
  plugin: string | null;
  mcpSlug?: string;
};

export type ToolSetRegistration = {
  id: string;
  name: string;
  category: string;
  description: string;
  buildTurnTools: (
    context: CoreToolSetContext,
    signal: AbortSignal | undefined,
    onFactoryFailed: () => void,
  ) => Promise<Record<string, Tool>>;
  staticTools?: Record<string, Tool>;
};

const TOOL_SETS = createContributionRegistry<ToolSetRegistration>({
  noun: "Tool set",
});

export const registerToolSet = (
  toolSetId: string,
  registration: Omit<ToolSetRegistration, "id">,
): ToolSetRegistration =>
  TOOL_SETS.register(toolSetId, { ...registration, id: toolSetId });

export const getToolSet = (
  toolSetId: string,
): ToolSetRegistration | undefined => TOOL_SETS.get(toolSetId);

export const hasToolSet = (toolSetId: string): boolean =>
  TOOL_SETS.has(toolSetId);

export const getToolSets = (): readonly ToolSetRegistration[] =>
  TOOL_SETS.list();

const SHARED_TOOL = Symbol("platypus.sharedTool");

export const shareTool = <T extends Tool>(key: string, tool: T): T =>
  Object.assign(tool, { [SHARED_TOOL]: key });

export const isSameSharedTool = (
  held: Tool | undefined,
  incoming: Tool,
): boolean => {
  const key = (held as { [SHARED_TOOL]?: string } | undefined)?.[SHARED_TOOL];
  return (
    key !== undefined &&
    key === (incoming as { [SHARED_TOOL]?: string })[SHARED_TOOL]
  );
};

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
  contribution: Omit<ToolSetContribution, "id">;
  id: string;
  plugin: PluginConfigContext;
  pluginName: string;
  isCore: boolean;
}

export const composeToolSet = (
  options: ComposeToolSetOptions,
): ToolSetRegistration => {
  const { contribution, id, plugin, pluginName, isCore } = options;
  const { name, category, description, tools } = contribution;

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
  const namespacedStaticTools = staticTools
    ? namespaceStaticToolsOrThrow(staticTools)
    : undefined;

  const buildTurnTools = async (
    context: CoreToolSetContext,
    signal: AbortSignal | undefined,
    onFactoryFailed: () => void,
  ): Promise<Record<string, Tool>> => {
    let resolved: unknown = tools;
    if (typeof tools === "function") {
      const ctx: ToolSetContext = withAttributedRegistrar(context, {
        plugin: pluginName,
        toolSet: id,
      });
      try {
        resolved = await withDeadline(
          () => tools(ctx, plugin),
          TOOL_SET_RESOLVE_TIMEOUT_MS,
          signal,
        );
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
          cause instanceof DeadlineExceededError
            ? `Tool set factory timed out after ${TOOL_SET_RESOLVE_TIMEOUT_MS}ms; serving none of its tools this turn`
            : cause instanceof CallerAbortedError
              ? "Tool set factory abandoned because the turn was cancelled"
              : "Tool set factory threw; serving none of its tools this turn",
        );
        if (!(cause instanceof CallerAbortedError)) onFactoryFailed();
        return {};
      }
    }

    if (!isRecord(resolved)) {
      logger.warn(
        { plugin: pluginName, toolSet: id },
        "Tool set resolved to no tool map; serving none of its tools this turn",
      );
      onFactoryFailed();
      return {};
    }

    return namespaceToolNames(
      normalizeToolResults(resolved as Record<string, Tool>),
    );
  };

  return {
    id,
    name,
    category,
    description,
    buildTurnTools,
    ...(namespacedStaticTools ? { staticTools: namespacedStaticTools } : {}),
  };
};

const CORE_PLUGIN_CONTEXT: PluginConfigContext = {
  config: undefined,
  credentials: undefined,
  get logger() {
    return logger.child({ plugin: CORE_BUILTIN_OWNER });
  },
};

export const MEMORY_TOOLSET_ID = "memory";

export const SANDBOX_TOOLSET_ID = "sandbox";

const modelFileReading = async (
  agentId: string,
  scope: { orgId: string; workspaceId: string },
): Promise<ModelFileReading> => {
  const noFileReading = {
    passthroughFileTypes: [],
    maxExtractedTextChars: DEFAULT_MAX_EXTRACTED_TEXT_CHARS,
  };
  const agent = await resolveScoped(db, "agent", agentId, scope);
  if (!agent) return noFileReading;
  const found = await resolveScoped(
    db,
    "provider",
    agent.row.providerId,
    scope,
  );
  if (!found) return noFileReading;
  const provider = found.row;
  const modelId = resolveModelId(provider, agent.row.modelId);
  if (!modelId) return noFileReading;
  return {
    passthroughFileTypes: passthroughFileTypesForModel(provider, modelId),
    maxExtractedTextChars: maxExtractedTextCharsForModel(provider, modelId),
  };
};

registerToolSet(
  SANDBOX_TOOLSET_ID,
  composeToolSet({
    id: SANDBOX_TOOLSET_ID,
    pluginName: CORE_BUILTIN_OWNER,
    plugin: CORE_PLUGIN_CONTEXT,
    isCore: true,
    contribution: {
      name: "Sandbox",
      category: "Sandbox",
      description:
        "Shell and filesystem access inside the workspace's configured sandbox",
      tools: async ({
        workspaceId,
        orgId,
        userId,
        agentId,
        registerCloser,
      }) => {
        const [row] = await db
          .select()
          .from(sandboxTable)
          .where(eq(sandboxTable.workspaceId, workspaceId))
          .limit(1);
        if (!row) return {};

        const plugin = getSandboxBackendPlugin(row.backend) ?? null;
        const registration = getSandboxBackend(row.backend);
        if (!registration) {
          logger.warn(
            { backend: row.backend, plugin, sandboxId: row.id },
            "Sandbox backend not registered; skipping sandbox tools for this turn",
          );
          return {};
        }

        const configResult = registration.configSchema.safeParse(row.config);
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
          row.credentials,
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
        if (backend.close) registerCloser(() => backend.close?.());
        const workspaceEnv = {
          ...row.userEnv,
          ...row.adminEnv,
        };
        return createSandboxTools(
          backend,
          { orgId, workspaceId, userId },
          workspaceEnv,
          () => modelFileReading(agentId, { orgId, workspaceId }),
        );
      },
    },
  }),
);
