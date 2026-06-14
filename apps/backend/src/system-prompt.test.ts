import { describe, it, expect } from "vitest";
import {
  renderSystemPrompt,
  type SystemPromptContext,
} from "./system-prompt.ts";
import type { agent as agentTable } from "./db/schema.ts";
import type { MemorySummary } from "./services/memory-retrieval.ts";

type AgentRecord = typeof agentTable.$inferSelect;

const baseCtx = (): SystemPromptContext => ({
  workspace: { id: "ws-1" },
  agent: null,
  user: { id: "user-1", name: "Alice" },
  memories: [],
  skills: [],
  subAgents: [],
  runMode: "interactive",
});

const agentRecord = (
  overrides: Partial<{
    systemPrompt: string | null;
    toolSetIds: string[] | null;
  }> = {},
): AgentRecord => ({
  id: "agent-1",
  organizationId: null,
  workspaceId: "ws-1",
  providerId: "p-1",
  name: "Helper",
  description: "test",
  systemPrompt: null,
  modelId: "gpt-4",
  maxSteps: null,
  temperature: null,
  topP: null,
  topK: null,
  seed: null,
  presencePenalty: null,
  frequencyPenalty: null,
  toolSetIds: null,
  skillIds: null,
  subAgentIds: null,
  inputPlaceholder: null,
  avatarKey: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const memorySummary = (
  summary: string,
  summaryDate = "2026-04-01",
): MemorySummary => ({
  id: "mem-1",
  userId: "user-1",
  workspaceId: "ws-1",
  summaryDate,
  summary,
  embedding: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe("renderSystemPrompt — agent prompt", () => {
  it("uses the agent's system prompt when agent is set", () => {
    const ctx = baseCtx();
    ctx.agent = agentRecord({ systemPrompt: "You are a researcher." });
    expect(renderSystemPrompt(ctx)).toMatch(/^You are a researcher\./);
  });

  it("falls back to fallbackSystemPrompt when agent is null", () => {
    const ctx = baseCtx();
    ctx.fallbackSystemPrompt = "Be concise.";
    expect(renderSystemPrompt(ctx)).toMatch(/^Be concise\./);
  });

  it("uses the default when neither agent nor fallback provides a prompt", () => {
    expect(renderSystemPrompt(baseCtx())).toMatch(
      /^You are a helpful AI assistant\./,
    );
  });

  it("uses the default when the agent's prompt is whitespace only", () => {
    const ctx = baseCtx();
    ctx.agent = agentRecord({ systemPrompt: "   " });
    expect(renderSystemPrompt(ctx)).toMatch(
      /^You are a helpful AI assistant\./,
    );
  });
});

describe("renderSystemPrompt — workspace", () => {
  it("renders the preamble alone when no workspace context is set", () => {
    const out = renderSystemPrompt(baseCtx());
    expect(out).toContain('The workspace id is "ws-1"');
    expect(out).not.toContain("<workspace>");
  });

  it("wraps workspace context in a <workspace> tag when present", () => {
    const ctx = baseCtx();
    ctx.workspace.context = "We sell rare books.";
    const out = renderSystemPrompt(ctx);
    expect(out).toContain("<workspace>\nWe sell rare books.\n</workspace>");
  });

  it("treats whitespace-only workspace context as absent", () => {
    const ctx = baseCtx();
    ctx.workspace.context = "   \n  ";
    expect(renderSystemPrompt(ctx)).not.toContain("<workspace>");
  });
});

describe("renderSystemPrompt — user", () => {
  it("renders the user's name and id", () => {
    const out = renderSystemPrompt(baseCtx());
    expect(out).toContain(
      'The current user\'s name is "Alice" and their id is "user-1"',
    );
  });
});

describe("renderSystemPrompt — user context", () => {
  it("emits no userContext block when neither global nor workspace context is set", () => {
    expect(renderSystemPrompt(baseCtx())).not.toContain("<userContext>");
  });

  it("emits only the global block when workspace context is missing", () => {
    const ctx = baseCtx();
    ctx.user.globalContext = "Likes haiku.";
    const out = renderSystemPrompt(ctx);
    expect(out).toContain("<userContext>\nLikes haiku.\n</userContext>");
    expect(out).not.toContain("<userWorkspaceContext>");
  });

  it("emits only the workspace block when global context is missing", () => {
    const ctx = baseCtx();
    ctx.user.workspaceContext = "PM on the books project.";
    const out = renderSystemPrompt(ctx);
    expect(out).toContain(
      "<userWorkspaceContext>\nPM on the books project.\n</userWorkspaceContext>",
    );
    expect(out).not.toContain("<userContext>\n");
  });

  it("emits both blocks when both contexts are set", () => {
    const ctx = baseCtx();
    ctx.user.globalContext = "Likes haiku.";
    ctx.user.workspaceContext = "PM on the books project.";
    const out = renderSystemPrompt(ctx);
    expect(out).toContain("<userContext>");
    expect(out).toContain("<userWorkspaceContext>");
  });
});

describe("renderSystemPrompt — memories block", () => {
  it("emits no <memories> block when there are no rows", () => {
    expect(renderSystemPrompt(baseCtx())).not.toContain("<memories>");
  });

  it("emits no <memories> block when rows have empty summaries", () => {
    const ctx = baseCtx();
    ctx.memories = [memorySummary("   ")];
    expect(renderSystemPrompt(ctx)).not.toContain("<memories>");
  });

  it("renders the <memories> block when rows have content", () => {
    const ctx = baseCtx();
    ctx.memories = [memorySummary("Asked about pricing.", "2026-04-29")];
    const out = renderSystemPrompt(ctx);
    expect(out).toContain("<memories>");
    expect(out).toContain("### 2026-04-29");
    expect(out).toContain("Asked about pricing.");
    expect(out).toContain("</memories>");
  });
});

describe("renderSystemPrompt — memory tools prose", () => {
  it("emits nothing when the agent does not have the memory tool set", () => {
    const ctx = baseCtx();
    ctx.agent = agentRecord({ toolSetIds: ["other"] });
    expect(renderSystemPrompt(ctx)).not.toContain("memorySearch");
  });

  it("emits the standalone prose when memory tools are enabled but no <memories> block exists", () => {
    const ctx = baseCtx();
    ctx.agent = agentRecord({ toolSetIds: ["memory"] });
    const out = renderSystemPrompt(ctx);
    expect(out).toContain(
      "You have access to memorySearch and memoryGet tools to look up memories from past conversations.",
    );
    expect(out).not.toContain("beyond what is shown above");
  });

  it("emits the supplemental prose when memory tools are enabled AND a <memories> block exists", () => {
    const ctx = baseCtx();
    ctx.agent = agentRecord({ toolSetIds: ["memory"] });
    ctx.memories = [memorySummary("Asked about pricing.")];
    const out = renderSystemPrompt(ctx);
    expect(out).toContain(
      "You also have access to memorySearch and memoryGet tools",
    );
    expect(out).toContain("beyond what is shown above");
    // Standalone prose must NOT be present when supplemental is.
    expect(out).not.toContain("look up memories from past conversations.");
  });
});

describe("renderSystemPrompt — skills", () => {
  it("emits no skills block when there are no skills", () => {
    expect(renderSystemPrompt(baseCtx())).not.toContain("<skills>");
  });

  it("renders one <skill> tag per skill", () => {
    const ctx = baseCtx();
    ctx.skills = [
      { name: "research", description: "Look things up" },
      { name: "summarise", description: "Summarise content" },
    ];
    const out = renderSystemPrompt(ctx);
    expect(out).toContain('<skill name="research">Look things up</skill>');
    expect(out).toContain('<skill name="summarise">Summarise content</skill>');
    expect(out).toContain("loadSkill tool");
  });
});

describe("renderSystemPrompt — sub-agents", () => {
  it("emits no sub-agents block when none are present", () => {
    expect(renderSystemPrompt(baseCtx())).not.toContain("Available Sub-Agents");
  });

  it("uses subAgentToolName for the slug and includes the description", () => {
    const ctx = baseCtx();
    ctx.subAgents = [
      { name: "Research Agent", description: "Looks things up." },
    ];
    const out = renderSystemPrompt(ctx);
    expect(out).toContain(
      "- **Research Agent**: Use the `delegateToResearchAgent` tool. Looks things up.",
    );
  });

  it("falls back to a default description when none is provided", () => {
    const ctx = baseCtx();
    ctx.subAgents = [{ name: "Helper" }];
    const out = renderSystemPrompt(ctx);
    expect(out).toContain("`delegateToHelper`");
    expect(out).toContain("No description provided");
  });
});

describe("renderSystemPrompt — headless run mode", () => {
  it("does not surface agent identity in interactive mode", () => {
    const ctx = baseCtx();
    ctx.agent = agentRecord({ systemPrompt: "You are a researcher." });
    const out = renderSystemPrompt(ctx);
    expect(out).not.toContain("agent-1");
    expect(out).not.toContain("an agent named");
    expect(out).toContain(
      'The current user\'s name is "Alice" and their id is "user-1"',
    );
  });

  it("surfaces agent identity with actionable phrasing in headless mode", () => {
    const ctx = baseCtx();
    ctx.runMode = "headless";
    ctx.agent = agentRecord({ systemPrompt: "You are a researcher." });
    const out = renderSystemPrompt(ctx);
    expect(out).toContain('You are an agent named "Helper" with id `agent-1`');
    expect(out).toContain("When a tool requires an agent identifier");
  });

  it("omits the agent-identity line in headless mode when no agent is resolved", () => {
    const ctx = baseCtx();
    ctx.runMode = "headless";
    const out = renderSystemPrompt(ctx);
    expect(out).not.toContain("an agent named");
  });

  it("reframes the user line as on-behalf-of in headless mode", () => {
    const ctx = baseCtx();
    ctx.runMode = "headless";
    const out = renderSystemPrompt(ctx);
    expect(out).toContain(
      'This run was initiated on behalf of "Alice" (id `user-1`)',
    );
    expect(out).toContain("There is no live user in this conversation");
    expect(out).not.toContain('The current user\'s name is "Alice"');
  });
});

describe("renderSystemPrompt — ordering snapshots", () => {
  it("minimal context", () => {
    expect(renderSystemPrompt(baseCtx())).toMatchInlineSnapshot(`
      "You are a helpful AI assistant.

      You are operating within the context of a workspace. The workspace id is "ws-1".

      The current user's name is "Alice" and their id is "user-1"."
    `);
  });

  it("full context with memories and memory tools (locks the supplemental prose path)", () => {
    const ctx = baseCtx();
    ctx.agent = agentRecord({
      systemPrompt: "You are a researcher.",
      toolSetIds: ["memory"],
    });
    ctx.workspace.context = "Books domain.";
    ctx.user.globalContext = "Likes haiku.";
    ctx.user.workspaceContext = "PM on books.";
    ctx.memories = [memorySummary("Asked about pricing.", "2026-04-29")];
    ctx.skills = [{ name: "research", description: "Look things up" }];
    ctx.subAgents = [{ name: "Helper", description: "Helps." }];

    expect(renderSystemPrompt(ctx)).toMatchInlineSnapshot(`
      "You are a researcher.

      You are operating within the context of a workspace. The workspace id is "ws-1".

      <workspace>
      Books domain.
      </workspace>

      The current user's name is "Alice" and their id is "user-1".

      Use the following context about the user to personalize your responses.

      <userContext>
      Likes haiku.
      </userContext>

      <userWorkspaceContext>
      PM on books.
      </userWorkspaceContext>

      <memories>
      Recent memory summaries from previous conversations:

      ### 2026-04-29
      Asked about pricing.
      </memories>

      You also have access to memorySearch and memoryGet tools to look up older or more specific memories beyond what is shown above.

      You have access to the following skills. When a user's request relates to one of these skills, use the loadSkill tool to retrieve the full skill content before responding.

      <skills>
      <skill name="research">Look things up</skill>
      </skills>

      ## Available Sub-Agents

      You can delegate specialized tasks to the following sub-agents. Each sub-agent has its own dedicated tool:

      - **Helper**: Use the \`delegateToHelper\` tool. Helps.

      Each task description MUST be entirely self-contained — sub-agents cannot see the parent conversation, other tasks, or any prior context. Include all relevant information directly in each task description. Wait for the sub-agent to complete before using its result."
    `);
  });
});

describe("renderSystemPrompt — sandbox fragment", () => {
  it("omits the sandbox block when the agent does not have the sandbox tool set", () => {
    const out = renderSystemPrompt({
      ...baseCtx(),
      agent: agentRecord({ toolSetIds: ["math-conversions"] }),
    });
    expect(out).not.toMatch(/## Sandbox/);
    expect(out).not.toMatch(/\/workspace/);
  });

  it("includes the sandbox block when the agent has the sandbox tool set", () => {
    const out = renderSystemPrompt({
      ...baseCtx(),
      agent: agentRecord({ toolSetIds: ["sandbox"] }),
    });
    expect(out).toMatch(/## Sandbox/);
    expect(out).toMatch(/\/workspace/);
    expect(out).toMatch(/persist across chat turns/);
    expect(out).toMatch(/fresh shell/);
    expect(out).toMatch(/truncated/);
  });

  it("omits the sandbox block when the agent has no tool sets", () => {
    const out = renderSystemPrompt({
      ...baseCtx(),
      agent: agentRecord({ toolSetIds: null }),
    });
    expect(out).not.toMatch(/## Sandbox/);
  });

  it("omits the env-vars line when sandboxEnvKeys is empty or absent", () => {
    const out = renderSystemPrompt({
      ...baseCtx(),
      agent: agentRecord({ toolSetIds: ["sandbox"] }),
      sandboxEnvKeys: [],
    });
    expect(out).toMatch(/## Sandbox/);
    expect(out).not.toMatch(/pre-set in every/);
  });

  it("lists env var keys (only) when sandboxEnvKeys is non-empty", () => {
    const out = renderSystemPrompt({
      ...baseCtx(),
      agent: agentRecord({ toolSetIds: ["sandbox"] }),
      sandboxEnvKeys: ["OPENAI_API_KEY", "GITHUB_TOKEN"],
    });
    expect(out).toMatch(/Available as `\$VAR`/);
    expect(out).toMatch(/pass to programs, don't echo/);
    expect(out).toMatch(/`OPENAI_API_KEY`/);
    expect(out).toMatch(/`GITHUB_TOKEN`/);
    expect(out).toMatch(/Workspace defaults override/);
  });
});
