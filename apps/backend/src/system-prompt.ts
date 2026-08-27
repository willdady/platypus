import { type Skill } from "@platypus/schemas";
import type { agent as agentTable } from "./db/schema.ts";
import { DELEGATE_TOOL_NAME } from "./tools/turn-tool-names.ts";
import { MEMORY_TOOLSET_ID, SANDBOX_TOOLSET_ID } from "./tools/index.ts";
import type { MemorySummary } from "./services/memory-retrieval.ts";
import { renderSecurityGuardrails } from "./security-prompt.ts";

// Re-exported for callers that reach the renderer through this module.
export { renderSecurityGuardrails };

type AgentRecord = typeof agentTable.$inferSelect;

/**
 * The half of the prompt context that is per-turn and therefore must NEVER
 * reach the prefix renderer (ADR-0020). It carries the volatile inputs a turn
 * resolves — data that would change the prefix if a fragment read it directly.
 *
 * The seam is the renderer's parameter type: `renderSystemPrompt` accepts only
 * {@link SystemPromptStableContext}, which physically lacks these fields. A
 * future volatile fragment therefore cannot read this data — doing so requires
 * widening the stable type, a one-line diff in a type named for stability that
 * a reviewer will question — rather than a review-miss guardrail. Today the
 * only volatile fragment input is the live memory retrieval, which the turn
 * folds into the stable `memoriesBlock` text before composition.
 */
export type SystemPromptTurnContext = {
  /**
   * The memories this turn resolved, when it retrieved them live (a headless
   * run with no Chat pin). Empty for an interactive run that re-used a pinned
   * snapshot. Folded into `SystemPromptStableContext.memoriesBlock` before the
   * renderer is ever called.
   */
  memories: MemorySummary[];
};

/**
 * The stable half of the prompt context — everything `renderSystemPrompt`
 * reads. By construction it carries no per-turn field (see
 * {@link SystemPromptTurnContext}): reaching the prefix requires a field to be
 * here, and the volatile inputs are deliberately absent, so a future fragment
 * cannot make the prefix vary with a background writer or the wall clock.
 */
export type SystemPromptStableContext = {
  workspace: { id: string; context?: string };
  agent: AgentRecord | null;
  user: {
    id: string;
    name: string;
    globalContext?: string;
    workspaceContext?: string;
  };
  /**
   * The resolved Memories block — the output of `formatSummariesForSystemPrompt`.
   * For an interactive Chat this is the text pinned on the Chat row, re-taken
   * only after the Chat idles past the re-pin horizon (ADR-0020); for a headless
   * run it is the live block resolved at turn time. Empty string → no Memories
   * block. The renderer never retrieves or reads a clock — it renders this text
   * as given, which is what keeps the prefix byte-identical across turns.
   */
  memoriesBlock: string;
  skills: Array<Pick<Skill, "name" | "description">>;
  subAgents: Array<{ name: string; description?: string | null }>;
  /**
   * Sub-agents assigned to this Agent that have no delegation tool this turn.
   * Named in the prompt as explicitly unavailable: staying silent leaves the
   * model to discover the gap by taking an AI_NoSuchToolError, and leaves the
   * user with no idea why.
   *
   * `name` is present only where the sub-agent's row resolved and the failure
   * came after (its Provider, its model). An assignment that did not resolve in
   * this Workspace has no name to report — deliberately: reading one off the row
   * is the Workspace boundary crossing being closed — so it is identified by the
   * `id` the Agent's own configuration holds.
   */
  unavailableSubAgents?: Array<{ id: string; name?: string; reason?: string }>;
  /**
   * Names of workspace-default env vars that will be merged into every
   * sandbox shell.exec call. Keys only — values never enter the system prompt
   * (see docs/adr/0004-sandbox-workspace-default-env-vars.md).
   */
  sandboxEnvKeys?: string[];
  /** Used as the instructions fragment when `agent` is null. */
  fallbackInstructions?: string;
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

type Fragment = (ctx: SystemPromptStableContext) => string | null;

const instructionsFragment: Fragment = (ctx) => {
  const instructions = ctx.agent?.instructions ?? ctx.fallbackInstructions;
  return instructions?.trim() || "You are a helpful AI assistant.";
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
  if (!ctx.memoriesBlock.trim()) return null;
  return `<memories>\n${ctx.memoriesBlock.trim()}\n</memories>`;
};

const memoryToolsFragment: Fragment = (ctx) => {
  const hasMemoryTools =
    ctx.agent?.toolSetIds?.includes(MEMORY_TOOLSET_ID) ?? false;
  if (!hasMemoryTools) return null;

  return ctx.memoriesBlock.trim()
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
  const unavailable = ctx.unavailableSubAgents ?? [];
  if (!ctx.subAgents.length && !unavailable.length) return null;

  const sections: string[] = [];

  if (ctx.subAgents.length) {
    const lines = ctx.subAgents.map(
      (sa) =>
        `- **${sa.name}**: ${sa.description || "No description provided"}`,
    );
    // The catalogue is the model's only route to a valid target — the
    // `delegate` tool resolves what it is given against exactly these names —
    // so each entry is named the way the tool expects it back.
    sections.push(`## Available Sub-Agents

You can delegate specialized tasks to the following sub-agents. Call the \`${DELEGATE_TOOL_NAME}\` tool with \`subAgent\` set to the name of the one you want:

${lines.join("\n")}

Each task description MUST be entirely self-contained — sub-agents cannot see the parent conversation, other tasks, or any prior context. Include all relevant information directly in each task description. Wait for the sub-agent to complete before using its result.`);
  }

  if (unavailable.length) {
    const lines = unavailable.map((sa) =>
      // Listed by whichever identifier it has — a nameless entry never resolved
      // far enough to have a name. Either way it is the identifier the
      // delegation tool refuses it under, where that tool exists at all.
      sa.name
        ? `- **${sa.name}**: ${sa.reason || "failed to load"}`
        : `- Sub-agent \`${sa.id}\`: ${sa.reason || "failed to load"}`,
    );
    // With nothing left to delegate to there is no delegation tool this turn,
    // so promising a refusal would describe a tool the model was never given.
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
