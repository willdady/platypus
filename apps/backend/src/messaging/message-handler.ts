import { nanoid } from "nanoid";
import { and, eq } from "drizzle-orm";
import { generateText, stepCountIs } from "ai";
import type { LanguageModel } from "ai";
import { db } from "../index.ts";
import {
  messagingSession as sessionTable,
  chat as chatTable,
  agent as agentTable,
  workspace as workspaceTable,
  provider as providerTable,
} from "../db/schema.ts";
import {
  createModel,
  loadTools,
  loadSkills,
  loadSubAgents,
  resolveGenerationConfig,
  prepareAgentTools,
  fetchUserContexts,
  fetchFormattedMemories,
} from "../services/chat-execution.ts";
import { generatePairingCode, findPairedUser } from "./pairing.ts";
import { logger } from "../logger.ts";
import type { IncomingMessage } from "./types.ts";
import type { PlatypusUIMessage } from "../types.ts";
import type { Provider } from "@platypus/schemas";

/**
 * Handles an incoming message from a messaging channel.
 * Returns the response text to send back.
 */
export const handleIncomingMessage = async (
  channelId: string,
  workspaceId: string,
  message: IncomingMessage,
): Promise<string | null> => {
  // 1. Check if user is paired
  const userId = await findPairedUser(channelId, message.externalChatId);

  if (!userId) {
    // Generate pairing code
    const code = await generatePairingCode(
      channelId,
      message.externalChatId,
      message.externalUserId,
      message.externalUsername,
    );

    return (
      `You need to link your account before chatting.\n\n` +
      `Your pairing code is: *${code}*\n\n` +
      `Enter this code in the Messaging settings of your workspace in Platypus.\n` +
      `This code expires in 1 hour.`
    );
  }

  // 2. Find or create active session
  let session: { id: string; chatId: string; agentId: string | null } | null =
    await findActiveSession(channelId, message.externalChatId);

  if (!session) {
    session = await createSession(channelId, workspaceId, message, userId);
    if (!session) {
      return "No agent is configured for this workspace. Please set a primary agent in workspace settings.";
    }
  }

  // 3. Resolve agent
  const agentRecord = await resolveAgent(session.agentId, workspaceId);
  if (!agentRecord) {
    return "No agent is configured for this workspace. Please set a primary agent in workspace settings.";
  }

  // 4. Execute chat
  try {
    const responseText = await executeChatMessage(
      session,
      agentRecord,
      workspaceId,
      userId,
      message.text,
    );
    return responseText;
  } catch (error) {
    logger.error(
      { error, channelId, sessionId: session.id },
      "Error executing chat message",
    );
    return "An error occurred while processing your message. Please try again.";
  }
};

/**
 * Handles the /new command - creates a fresh chat session.
 */
export const handleNewCommand = async (
  channelId: string,
  workspaceId: string,
  message: IncomingMessage,
): Promise<string | null> => {
  const userId = await findPairedUser(channelId, message.externalChatId);
  if (!userId) {
    return "You need to link your account first. Send any message to get a pairing code.";
  }

  // Deactivate current session
  await deactivateSession(channelId, message.externalChatId);

  // Create new session
  const session = await createSession(channelId, workspaceId, message, userId);
  if (!session) {
    return "No agent is configured for this workspace. Please set a primary agent in workspace settings.";
  }

  const agentRecord = await resolveAgent(session.agentId, workspaceId);
  const agentName = agentRecord?.name ?? "default agent";

  return `New chat session started with ${agentName}. Send a message to begin.`;
};

/**
 * Handles the /agent command - switches to a named agent and starts a new session.
 */
export const handleAgentCommand = async (
  channelId: string,
  workspaceId: string,
  agentName: string,
  message: IncomingMessage,
): Promise<string | null> => {
  const userId = await findPairedUser(channelId, message.externalChatId);
  if (!userId) {
    return "You need to link your account first. Send any message to get a pairing code.";
  }

  if (!agentName.trim()) {
    // List available agents
    const agents = await db
      .select({ name: agentTable.name, description: agentTable.description })
      .from(agentTable)
      .where(eq(agentTable.workspaceId, workspaceId));

    if (agents.length === 0) {
      return "No agents are configured in this workspace.";
    }

    const agentList = agents
      .map((a) => `- *${a.name}*: ${a.description}`)
      .join("\n");
    return `Available agents:\n${agentList}\n\nUse /agent <name> to switch.`;
  }

  // Find agent by name
  const agents = await db
    .select()
    .from(agentTable)
    .where(
      and(
        eq(agentTable.workspaceId, workspaceId),
        eq(agentTable.name, agentName.trim()),
      ),
    )
    .limit(1);

  if (agents.length === 0) {
    return `Agent "${agentName}" not found. Use /agent to see available agents.`;
  }

  const agent = agents[0];

  // Deactivate current session
  await deactivateSession(channelId, message.externalChatId);

  // Create new session with specific agent
  await createChatAndSession(
    channelId,
    workspaceId,
    message.externalChatId,
    userId,
    agent.id,
    `Telegram: ${agent.name}`,
  );

  return `Switched to agent *${agent.name}*. Send a message to begin.`;
};

/**
 * Returns help text listing available commands.
 */
export const handleHelpCommand = async (): Promise<string> => {
  return (
    `Available commands:\n\n` +
    `/new - Start a new chat session\n` +
    `/agent - List available agents\n` +
    `/agent <name> - Switch to a specific agent\n` +
    `/help - Show this help message`
  );
};

// --- Internal helpers ---

const findActiveSession = async (channelId: string, externalChatId: string) => {
  const sessions = await db
    .select()
    .from(sessionTable)
    .where(
      and(
        eq(sessionTable.channelId, channelId),
        eq(sessionTable.externalChatId, externalChatId),
        eq(sessionTable.isActive, true),
      ),
    )
    .limit(1);

  return sessions[0] ?? null;
};

const deactivateSession = async (channelId: string, externalChatId: string) => {
  await db
    .update(sessionTable)
    .set({ isActive: false, updatedAt: new Date() })
    .where(
      and(
        eq(sessionTable.channelId, channelId),
        eq(sessionTable.externalChatId, externalChatId),
        eq(sessionTable.isActive, true),
      ),
    );
};

const resolveAgent = async (
  agentId: string | null,
  workspaceId: string,
): Promise<typeof agentTable.$inferSelect | null> => {
  // Try session's agent first
  if (agentId) {
    const agents = await db
      .select()
      .from(agentTable)
      .where(eq(agentTable.id, agentId))
      .limit(1);

    if (agents.length > 0) return agents[0];
  }

  // Fall back to workspace's primary agent
  const workspaces = await db
    .select()
    .from(workspaceTable)
    .where(eq(workspaceTable.id, workspaceId))
    .limit(1);

  if (workspaces.length === 0 || !workspaces[0].primaryAgentId) return null;

  const agents = await db
    .select()
    .from(agentTable)
    .where(eq(agentTable.id, workspaces[0].primaryAgentId))
    .limit(1);

  return agents[0] ?? null;
};

const createChatAndSession = async (
  channelId: string,
  workspaceId: string,
  externalChatId: string,
  userId: string,
  agentId: string,
  title: string,
) => {
  const chatId = nanoid();
  const sessionId = nanoid();

  await db.insert(chatTable).values({
    id: chatId,
    workspaceId,
    title,
    messages: [],
    agentId,
    tags: [],
    memoryExtractionStatus: "completed",
  });

  await db.insert(sessionTable).values({
    id: sessionId,
    channelId,
    externalChatId,
    userId,
    chatId,
    agentId,
    isActive: true,
  });

  return { id: sessionId, channelId, externalChatId, userId, chatId, agentId, isActive: true };
};

const createSession = async (
  channelId: string,
  workspaceId: string,
  message: IncomingMessage,
  userId: string,
) => {
  const workspaces = await db
    .select()
    .from(workspaceTable)
    .where(eq(workspaceTable.id, workspaceId))
    .limit(1);

  if (workspaces.length === 0 || !workspaces[0].primaryAgentId) return null;

  return createChatAndSession(
    channelId,
    workspaceId,
    message.externalChatId,
    userId,
    workspaces[0].primaryAgentId,
    "Telegram Chat",
  );
};

const executeChatMessage = async (
  session: {
    id: string;
    chatId: string;
    agentId: string | null;
  },
  agent: typeof agentTable.$inferSelect,
  workspaceId: string,
  userId: string,
  userText: string,
): Promise<string> => {
  // 1. Get workspace and provider in parallel
  const [workspaces, providers] = await Promise.all([
    db
      .select()
      .from(workspaceTable)
      .where(eq(workspaceTable.id, workspaceId))
      .limit(1),
    db
      .select()
      .from(providerTable)
      .where(eq(providerTable.id, agent.providerId))
      .limit(1),
  ]);
  const workspace = workspaces[0];

  if (providers.length === 0) {
    throw new Error(`Provider '${agent.providerId}' not found for agent`);
  }
  const provider = providers[0];

  // 3. Create model
  const [, model] = createModel(provider as Provider, agent.modelId);

  // 4. Load tools
  const orgId = workspace.organizationId;
  const frontendUrl = process.env.FRONTEND_URL;
  const { tools, mcpClients } = await loadTools(
    agent,
    workspaceId,
    orgId,
    frontendUrl,
  );

  try {
    // 5. Load skills, sub-agents, user contexts, memories in parallel
    const user = { id: userId, name: "Messaging User" };
    const [
      skills,
      { subAgents, subAgentTools },
      { userGlobalContext, userWorkspaceContext },
      memoriesFormatted,
    ] = await Promise.all([
      loadSkills(agent, workspaceId),
      loadSubAgents(agent, orgId, workspaceId, frontendUrl),
      fetchUserContexts(userId, workspaceId),
      fetchFormattedMemories(userId, workspaceId),
    ]);
    Object.assign(tools, subAgentTools);

    // 9. Resolve generation config
    const config = await resolveGenerationConfig(
      {},
      workspaceId,
      agent,
      workspace.context || undefined,
      skills,
      user,
      userGlobalContext,
      userWorkspaceContext,
      subAgents,
      memoriesFormatted,
    );

    // 10. Prepare tools
    prepareAgentTools(tools, skills, workspaceId);

    // 10. Load existing messages
    const chatRecord = await db
      .select()
      .from(chatTable)
      .where(eq(chatTable.id, session.chatId))
      .limit(1);

    const existingMessages: PlatypusUIMessage[] =
      (chatRecord[0]?.messages as PlatypusUIMessage[]) ?? [];

    // 11. Build messages for AI
    const userMessage: PlatypusUIMessage = {
      id: nanoid(),
      role: "user",
      parts: [{ type: "text", text: userText }],
    };

    // Convert existing messages to AI SDK format for context
    const aiMessages = [...existingMessages, userMessage].map((m) => ({
      role: m.role as "user" | "assistant",
      content:
        m.parts
          ?.filter((p: any) => p.type === "text")
          .map((p: any) => p.text)
          .join("") ?? "",
    }));

    // 12. Execute with generateText
    const result = await generateText({
      model: model as LanguageModel,
      messages: aiMessages,
      tools,
      system: config.systemPrompt,
      stopWhen: [stepCountIs(agent.maxSteps ?? 1)],
      ...Object.fromEntries(
        Object.entries({
          temperature: config.temperature,
          topP: config.topP,
          topK: config.topK,
          frequencyPenalty: config.frequencyPenalty,
          presencePenalty: config.presencePenalty,
        }).filter(([, v]) => v !== undefined),
      ),
    });

    // 13. Build assistant message parts from all steps
    const parts: any[] = [];
    for (const step of result.steps) {
      // Add tool call parts
      for (const toolCall of step.toolCalls) {
        const toolResult = step.toolResults.find(
          (r: any) => r.toolCallId === toolCall.toolCallId,
        );
        parts.push({
          type: toolCall.dynamic ? "dynamic-tool" : `tool-${toolCall.toolName}`,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          state: toolResult ? "output-available" : "input-available",
          input: toolCall.input,
          ...(toolResult ? { output: toolResult.output } : {}),
        });
      }
      // Add text part if present
      if (step.text) {
        parts.push({ type: "text", text: step.text });
      }
    }

    // Fallback: if no parts were generated, use the final text
    if (parts.length === 0 && result.text) {
      parts.push({ type: "text", text: result.text });
    }

    const assistantMessage: PlatypusUIMessage = {
      id: nanoid(),
      role: "assistant",
      parts,
    };

    // 14. Save updated messages to chat
    const updatedMessages = [
      ...existingMessages,
      userMessage,
      assistantMessage,
    ];
    await db
      .update(chatTable)
      .set({
        messages: updatedMessages,
        updatedAt: new Date(),
      })
      .where(eq(chatTable.id, session.chatId));

    return result.text;
  } finally {
    // Close MCP clients
    for (const mcpClient of mcpClients) {
      try {
        await mcpClient.close();
      } catch (error) {
        logger.error({ error }, "Error closing MCP client");
      }
    }
  }
};
