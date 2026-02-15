# Plan: Migrate Sub-Agents to AI SDK Native Implementation

## Context

The sub-agents feature was implemented using client-side tool orchestration: the parent agent calls a `newTask` client-side tool (no execute function), the frontend intercepts it, opens a side pane with a separate Chat component that creates an independent chat session, and feeds the result back via `addToolOutput`. This involves significant frontend complexity (SubAgentProvider, SubAgentPane, session management, error handling, auto-resubmission).

The AI SDK (`ai` package v6.x) natively supports sub-agents via `ToolLoopAgent`. Sub-agents are defined as server-side tools with `execute` functions that run the sub-agent within the parent's tool execution. This eliminates the need for separate chat sessions, client-side orchestration, and the side pane entirely.

**Key shift**: Sub-agent execution moves from frontend orchestration to backend tool execution. Sub-agents become regular server-side tools that happen to run another agent internally.

---

## Phase 1: Backend — Replace Client-Side Tools with Server-Side Sub-Agent Tools

### Files to modify:

- `apps/backend/src/tools/sub-agent.ts` — Complete rewrite
- `apps/backend/src/routes/chat.ts` — Simplify sub-agent logic

### Changes:

**`apps/backend/src/tools/sub-agent.ts`** — Rewrite to use `ToolLoopAgent`:

```typescript
import { ToolLoopAgent, tool } from "ai";

export const createSubAgentTool = (
  subAgent: {
    id: string;
    name: string;
    description?: string;
    systemPrompt?: string;
  },
  model: LanguageModel,
  subAgentTools: Record<string, Tool>,
) => {
  const agent = new ToolLoopAgent({
    model,
    instructions: subAgent.systemPrompt || "You are a helpful assistant.",
    tools: subAgentTools,
  });

  return tool({
    description: `Delegate a task to sub-agent "${subAgent.name}": ${subAgent.description || "No description"}`,
    inputSchema: z.object({
      task: z.string().describe("Complete, self-contained task description"),
    }),
    execute: async function* ({ task }, { abortSignal }) {
      const result = await agent.stream({ prompt: task, abortSignal });
      for await (const message of readUIMessageStream({
        stream: result.toUIMessageStream(),
      })) {
        yield message;
      }
    },
    toModelOutput: ({ output: message }) => {
      const lastText = message?.parts.findLast((p) => p.type === "text");
      return { type: "text", value: lastText?.text ?? "Task completed." };
    },
  });
};
```

- Delete `createNewTaskTool` and `createTaskResultTool` (no longer needed)
- Each sub-agent becomes its own tool (e.g., `delegate_to_research`, `delegate_to_coder`) rather than a single `newTask` tool with a `subAgentId` parameter

**`apps/backend/src/routes/chat.ts`** — Simplify:

- Remove all `isSubAgentChat` / `parentChatId` logic
- Remove `taskResult` tool injection
- Remove sub-agent-specific stop conditions (`hasToolCall("taskResult")`, `stepCountIs(100)`)
- Remove `toolChoice: "required"` for sub-agent chats
- Instead: for each sub-agent, fetch its full config (model, tools, system prompt), create a `ToolLoopAgent`, and add the resulting tool to the parent's tool set
- Each sub-agent tool is named like `delegate_to_<agentName>` (slugified)
- The `parentChatId` field in `chatSubmitSchema` body and `upsertChatRecord` can be left in place for now (removed in Phase 3)

### Key considerations:

- Sub-agent tools need access to a model instance. The sub-agent's own provider/model config should be used (fetch from DB). If the sub-agent doesn't have its own provider, fall back to the parent's provider/model.
- Sub-agent tools need their own tools loaded (via `loadTools`). This means calling `loadTools` per sub-agent.
- Using `execute: async function*` with `yield` enables streaming preliminary results to the frontend.

---

## Phase 2: Frontend — Remove Client-Side Sub-Agent Orchestration

### Files to delete:

- `apps/frontend/components/sub-agent-context.tsx`
- `apps/frontend/components/sub-agent-session-context.tsx`
- `apps/frontend/components/new-task-tool.tsx`
- `apps/frontend/components/task-result-tool.tsx`
- `apps/frontend/components/sub-agent-pane.tsx`

### Files to modify:

- `apps/frontend/components/chat.tsx` — Remove all sub-agent props (`parentChatId`, `initialTask`, `isSubAgentMode`), remove result-feeding logic, remove session restoration, remove auto-send for sub-agent mode
- `apps/frontend/components/chat-message.tsx` — Remove `tool-newTask` and `tool-taskResult` rendering cases, remove `isSubAgentMode` prop
- `apps/frontend/app/[orgId]/workspace/[workspaceId]/chat/[chatId]/page.tsx` — Remove `SubAgentProvider` wrapper, remove `SubAgentPane`, remove agents fetch for side pane

### New UI consideration:

Sub-agent execution now appears as a regular tool call in the parent chat. The AI SDK streams preliminary results as the sub-agent works. We should render these as expandable/collapsible tool invocation cards showing the sub-agent's progress and final result. This uses the standard tool part rendering with `preliminary` flag detection — no special components needed beyond styling the tool output.

---

## Phase 3: Backend Cleanup — Remove Unused Fields and Code

### Files to modify:

- `apps/backend/src/db/schema.ts` — Remove `parentChatId` from chat table (sub-agent chats no longer exist as separate records)
- `apps/backend/src/system-prompt.ts` — Remove `isSubAgentMode` section and sub-agent instruction block (sub-agents now get instructions via `ToolLoopAgent.instructions`). Keep/adapt the "Available Sub-Agents" section since the parent still needs to know what tools are available.
- `apps/backend/src/types.ts` — Remove `SubAgentTools` type (`newTask`, `taskResult`), update `PlatypusTools`
- `apps/backend/src/routes/chat.ts` — Remove `parentChatId` from chat list filter (`isNull(chatTable.parentChatId)`)
- `apps/backend/src/services/sub-agent-validation.ts` — Keep as-is (still validates sub-agent assignments)
- `packages/schemas/index.ts` — Remove `newTaskToolInputSchema`, `taskResultToolInputSchema`, remove `parentChatId` from `chatSchema` and `chatSubmitSchema`

### Database migration:

- Run `pnpm drizzle-kit-push` after removing `parentChatId` from schema
- Any existing sub-agent chat records in the DB will have their `parentChatId` column dropped

---

## Phase 4: Testing & Verification

1. **Start dev server**: `pnpm dev`
2. **Apply schema changes**: `pnpm drizzle-kit-push`
3. **Create two agents**: A parent agent and a sub-agent, assign the sub-agent to the parent
4. **Test delegation**: Send a message to the parent that requires delegation — verify the sub-agent tool executes server-side and streams results
5. **Test tool isolation**: Verify sub-agents can use their own assigned tools
6. **Test depth limiting**: Sub-agents should NOT get `delegate_to_*` tools (enforced by not passing sub-agent tools to sub-agents)
7. **Test chat list**: Verify no phantom sub-agent chats appear in sidebar
8. **Test self-assignment prevention**: Verify agent form still prevents self-assignment
9. **Run tests**: `pnpm test`

---

## Summary of Architectural Change

| Aspect              | Before (Client-Side)                          | After (AI SDK Native)                                   |
| ------------------- | --------------------------------------------- | ------------------------------------------------------- |
| Execution           | Frontend orchestrates separate chat session   | Backend executes sub-agent within tool                  |
| UI                  | Side pane with full Chat component            | Inline tool result in parent chat                       |
| State               | SubAgentProvider, session management          | None needed                                             |
| DB                  | Separate chat record with `parentChatId`      | No separate records                                     |
| Streaming           | Separate streaming connection per sub-agent   | Preliminary tool results in parent stream               |
| Depth limit         | Don't inject `newTask` tool for sub-agents    | Don't add `delegate_to_*` tools for sub-agents          |
| Tools per sub-agent | Single `newTask` tool with `subAgentId` param | One tool per sub-agent (e.g., `delegate_to_researcher`) |
