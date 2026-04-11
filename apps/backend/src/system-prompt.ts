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
  const hasGlobal = globalContext && globalContext.trim();
  const hasWorkspace = workspaceContext && workspaceContext.trim();

  if (!hasGlobal && !hasWorkspace) return "";

  const parts: string[] = [
    "Use the following context about the user to personalize your responses.",
  ];

  if (hasGlobal) {
    parts.push(`<userContext>\n${globalContext!.trim()}\n</userContext>`);
  }

  if (hasWorkspace) {
    parts.push(
      `<userWorkspaceContext>\n${workspaceContext!.trim()}\n</userWorkspaceContext>`,
    );
  }

  return parts.join("\n\n");
}

/**
 * Renders the system prompt by combining workspace context and agent prompt.
 */
export function renderSystemPrompt(data: SystemPromptTemplateData): string {
  const parts: string[] = [];

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

You can delegate specialized tasks to the following sub-agents. Each sub-agent has its own dedicated tool:

${data.subAgents
  .map(
    (sa) =>
      `- **${sa.name}**: Use the \`delegate_to_${sa.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(
          /^_|_$/g,
          "",
        )}\` tool. ${sa.description || "No description provided"}`,
  )
  .join("\n")}

Each task description MUST be entirely self-contained — sub-agents cannot see the parent conversation, other tasks, or any prior context. Include all relevant information directly in each task description. Wait for the sub-agent to complete before using its result.`);
  }

  return parts.filter(Boolean).join("\n\n");
}
