interface SystemPromptTemplateData {
  workspaceId: string;
  workspaceContext?: string;
  agentSystemPrompt?: string;
}

/**
 * Renders a workspace-specific fragment for the system prompt.
 */
export function renderWorkspaceFragment(workspaceId: string, workspaceContext?: string): string {
  const preamble = `You are operating within the context of a workspace. The workspace id is "${workspaceId}".`;
  if (!workspaceContext) return preamble;
  return `
${preamble}
Context about the workspace is provided inside the <workspace></workspace> XML tags below. Use this context to inform your responses.

<workspace>
${workspaceContext}
</workspace>
  `.trim();
}

/**
 * Renders the system prompt by combining workspace context and agent prompt.
 */
export function renderSystemPrompt(
  data: SystemPromptTemplateData,
): string {
  const parts: string[] = [];

  if (data.agentSystemPrompt) {
    parts.push(data.agentSystemPrompt.trim());
  } else {
    parts.push("You are a helpful AI assistant.");
  }

  parts.push(renderWorkspaceFragment(data.workspaceId, data.workspaceContext));

  return parts.join("\n\n");
}
