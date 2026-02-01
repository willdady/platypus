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

  if (data.skills && data.skills.length > 0) {
    parts.push(renderSkillsFragment(data.skills));
  }

  return parts.join("\n\n");
}
