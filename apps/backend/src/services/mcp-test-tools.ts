import {
  TOOL_NAME_PATTERN,
  namespaceMcpToolName,
  slugifyMcpName,
} from "@platypus/schemas";

export type NamespacedTestToolNames = {
  toolNames: string[];
  invalidToolNames: string[];
};

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

export const resolveMcpTestToolNames = (
  rawToolNames: readonly string[],
  name: string | undefined,
  storedName: string | undefined,
): NamespacedTestToolNames => {
  const nameForSlug = name ?? storedName;
  if (!nameForSlug) {
    return { toolNames: [...rawToolNames], invalidToolNames: [] };
  }
  return namespaceMcpTestToolNames(slugifyMcpName(nameForSlug), rawToolNames);
};
