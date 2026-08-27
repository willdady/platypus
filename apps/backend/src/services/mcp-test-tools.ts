import {
  TOOL_NAME_PATTERN,
  namespaceMcpToolName,
  slugifyMcpName,
} from "@platypus/schemas";

/** What the MCP test-connection routes report for one server's tool list. */
export type NamespacedTestToolNames = {
  /** Namespaced names valid for a Chat turn to call. */
  toolNames: string[];
  /**
   * Namespaced names that fail the model-provider name ceiling
   * (`TOOL_NAME_PATTERN`) and would be excluded from a turn — reported so
   * an Operator sees the same exclusion the Tool session applies later,
   * before ever attaching the MCP.
   */
  invalidToolNames: string[];
};

/**
 * Namespace a test connection's raw tool names under the MCP's slug, the same
 * way the Tool session does at Chat-turn time (issue #467) — so what the test
 * screen reports is exactly what a turn will see, not a preview that can
 * silently disagree with it.
 */
export const namespaceMcpTestToolNames = (
  slug: string,
  rawToolNames: readonly string[],
): NamespacedTestToolNames => {
  const toolNames: string[] = [];
  const invalidToolNames: string[] = [];
  for (const raw of rawToolNames) {
    const namespaced = namespaceMcpToolName(slug, raw);
    if (TOOL_NAME_PATTERN.test(namespaced)) {
      toolNames.push(namespaced);
    } else {
      invalidToolNames.push(namespaced);
    }
  }
  return { toolNames, invalidToolNames };
};

/**
 * The mcp.ts and org-mcp.ts test-connection routes' shared shape: namespace
 * under the form's current Name, falling back to the stored MCP's name (for a
 * re-test with no name change) when a `mcpId` is given, or leaving names
 * unnamespaced when neither is available. `fetchStoredName` differs between
 * the two routes only in which scoped-lookup helper it calls, so it is the
 * one thing each caller still supplies itself.
 */
export const resolveMcpTestToolNames = async (
  rawToolNames: readonly string[],
  name: string | undefined,
  mcpId: string | undefined,
  fetchStoredName: (mcpId: string) => Promise<string | undefined>,
): Promise<NamespacedTestToolNames> => {
  const nameForSlug =
    name ?? (mcpId ? await fetchStoredName(mcpId) : undefined);
  if (!nameForSlug) {
    return { toolNames: [...rawToolNames], invalidToolNames: [] };
  }
  return namespaceMcpTestToolNames(slugifyMcpName(nameForSlug), rawToolNames);
};
