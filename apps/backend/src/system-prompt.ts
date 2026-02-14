import { type Skill } from "@platypus/schemas";

interface SystemPromptTemplateData {
  workspaceId: string;
  workspaceContext?: string;
  agentSystemPrompt?: string;
  skills?: Array<Pick<Skill, "name" | "description">>;
  user: {
    id: string;
    name: string;
  };
  userGlobalContext?: string;
  userWorkspaceContext?: string;
  isSubAgentMode?: boolean;
  subAgents?: Array<{ id: string; name: string; description?: string }>;
  memoriesFormatted?: string;
}

/**
 * Renders a workspace-specific fragment for the system prompt.
 */
export function renderWorkspaceFragment(
  workspaceId: string,
  workspaceContext?: string,
): string {
  const preamble = `You are operating within the context of a workspace. The workspace id is "${workspaceId}".`;
  if (!workspaceContext || !workspaceContext.trim()) return preamble;
  return `
${preamble}
Context about the workspace is provided inside the <workspace></workspace> XML tags below. Use this context to inform your responses only when relevant to the user's request.

<workspace>
${workspaceContext.trim()}
</workspace>
  `.trim();
}

/**
 * Renders skill summaries as XML tags for the system prompt.
 */
export function renderSkillsFragment(
  skills: Array<Pick<Skill, "name" | "description">>,
): string {
  if (!skills || skills.length === 0) return "";

  const skillsXml = skills
    .map((skill) => `<skill name="${skill.name}">${skill.description}</skill>`)
    .join("\n");

  return `
You have access to the following skills. When a user's request relates to one of these skills, use the loadSkill tool to retrieve the full skill content before responding.

<skills>
${skillsXml}
</skills>
  `.trim();
}

/**
 * Renders user information as XML tags for the system prompt.
 */
export function renderUserFragment(user: { id: string; name: string }): string {
  return `The current user's name is "${user.name}" and their id is "${user.id}".`;
}

/**
 * Renders user context fragments (global and workspace-specific) for the system prompt.
 */
export function renderUserContextFragment(
  globalContext?: string,
  workspaceContext?: string,
): string {
  const parts: string[] = [];

  if (globalContext && globalContext.trim()) {
    parts.push(
      `
The following is general context about the user, provided inside the <userContext></userContext> XML tags. Use this context to personalize your responses.

<userContext>
${globalContext.trim()}
</userContext>
    `.trim(),
    );
  }

  if (workspaceContext && workspaceContext.trim()) {
    parts.push(
      `
The following is workspace-specific context about the user, provided inside the <userWorkspaceContext></userWorkspaceContext> XML tags. Use this context to personalize your responses.

<userWorkspaceContext>
${workspaceContext.trim()}
</userWorkspaceContext>
    `.trim(),
    );
  }

  return parts.join("\n\n");
}

/**
 * Renders the system prompt by combining workspace context and agent prompt.
 */
export function renderSystemPrompt(data: SystemPromptTemplateData): string {
  const parts: string[] = [];

  if (data.isSubAgentMode) {
    parts.push(`## Important: Sub-Agent Mode

You are running as a sub-agent delegated a specific task.

CRITICAL INSTRUCTIONS:
- Focus ONLY on the task you have been assigned
- When you have completed the task, you MUST call the \`taskResult\` tool
- The \`taskResult\` tool is the ONLY way to return control to the parent agent
- Include all relevant findings and outputs in your result
- Set status to "success" if you completed the task, "error" if you could not
`);
  }

  if (data.agentSystemPrompt) {
    parts.push(data.agentSystemPrompt.trim());
  } else {
    parts.push("You are a helpful AI assistant.");
  }

  parts.push(renderWorkspaceFragment(data.workspaceId, data.workspaceContext));

  parts.push(renderUserFragment(data.user));

  const userContextFragment = renderUserContextFragment(
    data.userGlobalContext,
    data.userWorkspaceContext,
  );
  if (userContextFragment) {
    parts.push(userContextFragment);
  }

  // Add memories if available
  if (data.memoriesFormatted) {
    parts.push(data.memoriesFormatted);
  }

  if (data.skills && data.skills.length > 0) {
    parts.push(renderSkillsFragment(data.skills));
  }

  // Add sub-agent information
  if (data.subAgents && data.subAgents.length > 0) {
    parts.push(`## Available Sub-Agents

You can delegate specialized tasks to the following sub-agents using the \`newTask\` tool:

${data.subAgents.map((sa) => `- **${sa.name}** (ID: ${sa.id}): ${sa.description || "No description provided"}`).join("\n")}

When delegating to a sub-agent:
1. Each task description MUST be entirely self-contained. Sub-agents cannot see the parent conversation, other sub-agent tasks, or any prior context. Never use references like "the first one", "the other task", "as mentioned above", etc.
2. Include all relevant information, constraints, and requirements directly in the task description
3. If delegating multiple related tasks, make each task independently understandable without knowledge of the others
4. Wait for the sub-agent to complete before continuing
5. Use the result returned by the sub-agent to continue your work`);
  }

  return parts.filter(Boolean).join("\n\n");
}
