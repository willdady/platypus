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
}

/**
 * Renders a workspace-specific fragment for the system prompt.
 */
export function renderWorkspaceFragment(
  workspaceId: string,
  workspaceContext?: string,
): string {
  const preamble = `You are operating within the context of a workspace. The workspace id is "${workspaceId}".`;
  if (!workspaceContext) return preamble;
  return `
${preamble}
Context about the workspace is provided inside the <workspace></workspace> XML tags below. Use this context to inform your responses only when relevant to the user's request.

<workspace>
${workspaceContext}
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

  if (data.skills && data.skills.length > 0) {
    parts.push(renderSkillsFragment(data.skills));
  }

  return parts.join("\n\n");
}
