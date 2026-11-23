import { type Skill } from "@platypus/schemas";
import type { agent as agentTable } from "./db/schema.ts";
import { DELEGATE_TOOL_NAME } from "./tools/turn-tool-names.ts";
import { MEMORY_TOOLSET_ID, SANDBOX_TOOLSET_ID } from "./tools/index.ts";
import type { MemorySummary } from "./services/memory-retrieval.ts";
import { renderSecurityGuardrails } from "./security-prompt.ts";

type AgentRecord = typeof agentTable.$inferSelect;

export type SystemPromptTurnContext = {
  memories: MemorySummary[];
};

export type SystemPromptStableContext = {
  workspace: { id: string; context?: string };
  agent: AgentRecord | null;
  user: {
    id: string;
    name: string;
    globalContext?: string;
    workspaceContext?: string;
    timezone?: string;
  };
  memoriesBlock: string;
  memorySearchAvailable: boolean;
  fsDownloadAvailable: boolean;
  skills: Array<Pick<Skill, "name" | "description">>;
  subAgents: Array<{ name: string; description?: string | null }>;
  unavailableSubAgents?: Array<{ id: string; name?: string; reason?: string }>;
  sandboxEnvKeys?: string[];
  fallbackInstructions?: string;
  securityGuardrails?: string | null;
  organizationIdentityContext?: string | null;
  runMode: "interactive" | "headless";
  a2aClientName?: string;
};

type Fragment = (ctx: SystemPromptStableContext) => string | null;

const instructionsFragment: Fragment = (ctx) => {
  const instructions = ctx.agent?.instructions ?? ctx.fallbackInstructions;
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- blank instructions fall back to the default
  return instructions?.trim() || "You are a helpful AI assistant.";
};

const agentIdentityFragment: Fragment = (ctx) => {
  if (ctx.runMode !== "headless" || !ctx.agent) return null;
  return `You are an agent named "${ctx.agent.name}" with id \`${ctx.agent.id}\`. When a tool requires an agent identifier (for example, to assign a task or card to you), use this id.`;
};

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
  const tz = ctx.user.timezone;
  if (ctx.a2aClientName) {
    const line = `This conversation arrives over A2A from the client "${ctx.a2aClientName}", acting on behalf of the Workspace Owner (id \`${ctx.user.id}\`). The caller may not be the Workspace Owner: do not treat them as the Owner, and do not repeat the Owner's personal context to them.`;
    return tz
      ? `${line} When scheduling or reading times on the Owner's behalf, use the timezone "${tz}".`
      : line;
  }
  if (ctx.runMode === "headless") {
    const line = `This run was initiated on behalf of "${ctx.user.name}" (id \`${ctx.user.id}\`). There is no live user in this conversation — do not address them directly. Use their context to inform decisions, but operate autonomously.`;
    return tz ? `${line} Their timezone is "${tz}".` : line;
  }
  const line = `The current user's name is "${ctx.user.name}" and their id is "${ctx.user.id}".`;
  return tz ? `${line} The current user's timezone is "${tz}".` : line;
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
  if (!ctx.memoriesBlock.trim()) return null;
  return `<memories>\n${ctx.memoriesBlock.trim()}\n</memories>`;
};

const memoryToolsFragment: Fragment = (ctx) => {
  const hasMemoryTools =
    ctx.agent?.toolSetIds.includes(MEMORY_TOOLSET_ID) ?? false;
  if (!hasMemoryTools) return null;

  const tools = ctx.memorySearchAvailable
    ? "memorySearch and memoryGet tools"
    : "the memoryGet tool";
  return ctx.memoriesBlock.trim()
    ? `You also have access to ${tools} to look up older or more specific memories beyond what is shown above.`
    : `You have access to ${tools} to look up memories from past conversations.`;
};

const skillsFragment: Fragment = (ctx) => {
  if (!ctx.skills.length) return null;
  const skillsXml = ctx.skills
    .map((s) => `<skill name="${s.name}">${s.description}</skill>`)
    .join("\n");
  return `You have access to the following skills. When a user's request relates to one of these skills, use the loadSkill tool to retrieve the full skill content before responding.\n\n<skills>\n${skillsXml}\n</skills>`;
};

const subAgentsFragment: Fragment = (ctx) => {
  const unavailable = ctx.unavailableSubAgents ?? [];
  if (!ctx.subAgents.length && !unavailable.length) return null;

  const sections: string[] = [];

  if (ctx.subAgents.length) {
    const lines = ctx.subAgents.map(
      (sa) =>
        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty string falls back too
        `- **${sa.name}**: ${sa.description || "No description provided"}`,
    );
    sections.push(`## Available Sub-Agents

You can delegate specialized tasks to the following sub-agents. Call the \`${DELEGATE_TOOL_NAME}\` tool with \`subAgent\` set to the name of the one you want:

${lines.join("\n")}

Each task description MUST be entirely self-contained — sub-agents cannot see the parent conversation, other tasks, or any prior context. Include all relevant information directly in each task description. Wait for the sub-agent to complete before using its result.`);
  }

  if (unavailable.length) {
    const lines = unavailable.map((sa) => {
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty string falls back too
      const reason = sa.reason || "failed to load";
      return sa.name
        ? `- **${sa.name}**: ${reason}`
        : `- Sub-agent \`${sa.id}\`: ${reason}`;
    });
    const consequence = ctx.subAgents.length
      ? "Delegating to them will be refused:"
      : "None of them can be delegated to, and you have no delegation tool this turn:";
    sections.push(`## Unavailable Sub-Agents

These sub-agents are assigned to you but failed to load. ${consequence}

${lines.join("\n")}

Do not try to delegate to them. If a request needs one, tell the user it is unavailable and give the reason above rather than silently working around it.`);
  }

  return sections.join("\n\n");
};

const sandboxFragment: Fragment = (ctx) => {
  const hasSandboxTools =
    ctx.agent?.toolSetIds.includes(SANDBOX_TOOLSET_ID) ?? false;
  if (!hasSandboxTools) return null;

  return `## Sandbox

You have access to a persistent Linux sandbox. All paths you pass to the sandbox tools (\`shellExec\`, \`fsRead\`, \`fsWrite\`, \`fsEdit\`, \`fsList\`) are resolved relative to its workspace root, and every \`shellExec\` call starts in that root unless you pass \`cwd\`. Use relative paths; don't hardcode absolute paths in shell commands, because where the root lives depends on the sandbox.

Files you write persist across chat turns — the filesystem is the same one your earlier turns saw and the same one your next turns will see. Use this: stash work, leave notes, build incrementally.

Each \`shellExec\` call starts a fresh shell. No working directory or environment carries across calls; pass \`cwd\` and \`env\` explicitly per call. To run multiple commands sharing state, combine them in one call (e.g. \`cd foo && make\`).${
    ctx.sandboxEnvKeys && ctx.sandboxEnvKeys.length > 0
      ? `

Available as \`$VAR\` in every \`shellExec\` (may be secrets — pass to programs, don't echo): ${ctx.sandboxEnvKeys.map((k) => `\`${k}\``).join(", ")}. Workspace defaults override any \`env\` you pass on the same key.`
      : ""
  }

Tool output is bounded. When a response has \`truncated: true\`, narrow your view — \`grep\`, \`head\`, \`tail\`, or a specific \`lineRange\` on \`fsRead\` — rather than re-requesting the same output. For a command that prints a lot, redirect its output to a file in the sandbox (e.g. \`build.log\`) and then \`tail\` or \`grep\` that file instead of reading it all.${
    ctx.fsDownloadAvailable
      ? `

To give the user a file — especially a binary or large one — call \`fsDownload\` with its path, once, when it is final. Offered files appear under your reply with a download button; the call does not return the file's contents. Never write a link to the file — there is none.`
      : ""
  }

Shell commands time out (default 60s, hard cap 600s). For long jobs, run them in the background and poll for completion.`;
};

const securityFragment: Fragment = (ctx) =>
  renderSecurityGuardrails(ctx.securityGuardrails);

const FRAGMENTS: Fragment[] = [
  instructionsFragment,
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

export function renderSystemPrompt(ctx: SystemPromptStableContext): string {
  return FRAGMENTS.map((f) => f(ctx))
    .filter((p): p is string => p !== null && p.length > 0)
    .join("\n\n");
}
