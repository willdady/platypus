import { type Skill } from "@platypus/schemas";
import type { agent as agentTable } from "./db/schema.ts";
import { subAgentToolName } from "./tools/sub-agent.ts";
import { MEMORY_TOOLSET_ID, SANDBOX_TOOLSET_ID } from "./tools/index.ts";
import {
  formatSummariesForSystemPrompt,
  type MemorySummary,
} from "./services/memory-retrieval.ts";
import { renderSecurityGuardrails } from "./security-prompt.ts";

// Re-exported for callers that reach the renderer through this module.
export { renderSecurityGuardrails };

type AgentRecord = typeof agentTable.$inferSelect;

export type SystemPromptContext = {
  workspace: { id: string; context?: string };
  agent: AgentRecord | null;
  user: {
    id: string;
    name: string;
    globalContext?: string;
    workspaceContext?: string;
  };
  memories: MemorySummary[];
  skills: Array<Pick<Skill, "name" | "description">>;
  subAgents: Array<{ name: string; description?: string | null }>;
  /**
   * Names of workspace-default env vars that will be merged into every
   * sandbox shell.exec call. Keys only — values never enter the system prompt
   * (see docs/adr/0004-sandbox-workspace-default-env-vars.md).
   */
  sandboxEnvKeys?: string[];
  /** Used as the system prompt when `agent` is null. */
  fallbackSystemPrompt?: string;
  /**
   * Free-text security directives from the run's provider
   * (`provider.securityGuardrails`). Rendered LAST (recency). Empty/nullish →
   * no security block is added.
   */
  securityGuardrails?: string | null;
  /**
   * Free-text organization identity / context (`organization.identityContext`).
   * Rendered EARLY, beside the workspace context, as framing — NOT a security
   * control. Empty/nullish → no organization block is added. A plain string:
   * no org id is printed (unlike the workspace, whose id tools require).
   */
  organizationIdentityContext?: string | null;
  /**
   * "interactive" — a live user is chatting; the agent may swap between turns.
   * "headless" — a trigger or sub-agent run; the agent is fixed for the whole
   * run and there is no live participant. Headless mode surfaces the agent's
   * own identity and reframes the user line as an on-behalf-of owner.
   */
  runMode: "interactive" | "headless";
};

type Fragment = (ctx: SystemPromptContext) => string | null;

const agentPromptFragment: Fragment = (ctx) => {
  const prompt = ctx.agent?.systemPrompt ?? ctx.fallbackSystemPrompt;
  return prompt?.trim() || "You are a helpful AI assistant.";
};

const agentIdentityFragment: Fragment = (ctx) => {
  if (ctx.runMode !== "headless" || !ctx.agent) return null;
  return `You are an agent named "${ctx.agent.name}" with id \`${ctx.agent.id}\`. When a tool requires an agent identifier (for example, to assign a task or card to you), use this id.`;
};

// Organization identity / context, rendered early (beside the workspace
// context) as framing. Not a security control — that is securityFragment, which
// renders last. Deliberately not adjacent to it.
const organizationFragment: Fragment = (ctx) => {
  const context = ctx.organizationIdentityContext?.trim();
  if (!context) return null;
  return `<organization>\n${context}\n</organization>`;
};

const workspaceFragment: Fragment = (ctx) => {
  const preamble = `You are operating within the context of a workspace. The workspace id is "${ctx.workspace.id}".`;
  const context = ctx.workspace.context?.trim();
  if (!context) return preamble;
  return `${preamble}\n\n<workspace>\n${context}\n</workspace>`;
};

const userFragment: Fragment = (ctx) => {
  if (ctx.runMode === "headless") {
    return `This run was initiated on behalf of "${ctx.user.name}" (id \`${ctx.user.id}\`). There is no live user in this conversation — do not address them directly. Use their context to inform decisions, but operate autonomously.`;
  }
  return `The current user's name is "${ctx.user.name}" and their id is "${ctx.user.id}".`;
};

const userContextFragment: Fragment = (ctx) => {
  const global = ctx.user.globalContext?.trim();
  const workspace = ctx.user.workspaceContext?.trim();
  if (!global && !workspace) return null;

  const parts: string[] = [
    "Use the following context about the user to personalize your responses.",
  ];
  if (global) parts.push(`<userContext>\n${global}\n</userContext>`);
  if (workspace)
    parts.push(`<userWorkspaceContext>\n${workspace}\n</userWorkspaceContext>`);
  return parts.join("\n\n");
};

const memoriesBlockFragment: Fragment = (ctx) => {
  const formatted = formatSummariesForSystemPrompt(ctx.memories);
  if (!formatted) return null;
  return `<memories>\n${formatted}\n</memories>`;
};

const memoryToolsFragment: Fragment = (ctx) => {
  const hasMemoryTools =
    ctx.agent?.toolSetIds?.includes(MEMORY_TOOLSET_ID) ?? false;
  if (!hasMemoryTools) return null;

  const hasMemoriesBlock = !!formatSummariesForSystemPrompt(ctx.memories);
  return hasMemoriesBlock
    ? "You also have access to memorySearch and memoryGet tools to look up older or more specific memories beyond what is shown above."
    : "You have access to memorySearch and memoryGet tools to look up memories from past conversations.";
};

const skillsFragment: Fragment = (ctx) => {
  if (!ctx.skills.length) return null;
  const skillsXml = ctx.skills
    .map((s) => `<skill name="${s.name}">${s.description}</skill>`)
    .join("\n");
  return `You have access to the following skills. When a user's request relates to one of these skills, use the loadSkill tool to retrieve the full skill content before responding.\n\n<skills>\n${skillsXml}\n</skills>`;
};

const subAgentsFragment: Fragment = (ctx) => {
  if (!ctx.subAgents.length) return null;
  const lines = ctx.subAgents.map(
    (sa) =>
      `- **${sa.name}**: Use the \`${subAgentToolName(sa)}\` tool. ${sa.description || "No description provided"}`,
  );
  return `## Available Sub-Agents

You can delegate specialized tasks to the following sub-agents. Each sub-agent has its own dedicated tool:

${lines.join("\n")}

Each task description MUST be entirely self-contained — sub-agents cannot see the parent conversation, other tasks, or any prior context. Include all relevant information directly in each task description. Wait for the sub-agent to complete before using its result.`;
};

const sandboxFragment: Fragment = (ctx) => {
  const hasSandboxTools =
    ctx.agent?.toolSetIds?.includes(SANDBOX_TOOLSET_ID) ?? false;
  if (!hasSandboxTools) return null;

  return `## Sandbox

You have access to a persistent Linux sandbox rooted at \`/workspace\`. All paths you pass to the sandbox tools (\`shellExec\`, \`fsRead\`, \`fsWrite\`, \`fsEdit\`, \`fsList\`) are resolved relative to this root.

Files you write persist across chat turns — the filesystem is the same one your earlier turns saw and the same one your next turns will see. Use this: stash work, leave notes, build incrementally.

Each \`shellExec\` call starts a fresh shell. No working directory or environment carries across calls; pass \`cwd\` and \`env\` explicitly per call. To run multiple commands sharing state, combine them in one call (e.g. \`cd foo && make\`).${
    ctx.sandboxEnvKeys && ctx.sandboxEnvKeys.length > 0
      ? `

Available as \`$VAR\` in every \`shellExec\` (may be secrets — pass to programs, don't echo): ${ctx.sandboxEnvKeys.map((k) => `\`${k}\``).join(", ")}. Workspace defaults override any \`env\` you pass on the same key.`
      : ""
  }

Tool output is bounded. When a response has \`truncated: true\`, narrow your view — \`grep\`, \`head\`, \`tail\`, or a specific \`lineRange\` on \`fsRead\` — rather than re-requesting the same output.

Shell commands time out (default 60s, hard cap 600s). For long jobs, run them in the background and poll for completion.`;
};

// Security directives from the provider, rendered last so they are the final
// instructions the model reads before the conversation (recency strengthens
// injection resistance). No-op when the provider has no security text.
const securityFragment: Fragment = (ctx) =>
  renderSecurityGuardrails(ctx.securityGuardrails);

const FRAGMENTS: Fragment[] = [
  agentPromptFragment,
  agentIdentityFragment,
  organizationFragment,
  workspaceFragment,
  userFragment,
  userContextFragment,
  memoriesBlockFragment,
  memoryToolsFragment,
  skillsFragment,
  subAgentsFragment,
  sandboxFragment,
  securityFragment,
];

export function renderSystemPrompt(ctx: SystemPromptContext): string {
  return FRAGMENTS.map((f) => f(ctx))
    .filter((p): p is string => p !== null && p.length > 0)
    .join("\n\n");
}
