import { Hono } from "hono";
import { validate } from "../validate.ts";
import { z } from "zod";
import { db } from "../index.ts";
import { chat as chatTable } from "../db/schema.ts";
import { ConflictError, NotFoundError, UpstreamError } from "../errors.ts";
import {
  chatActiveLeafSchema,
  chatCompactSchema,
  chatSubmitSchema,
  chatUpdateSchema,
  paginationQuerySchema,
} from "@platypus/schemas";
import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  workspaceScopeOf,
} from "../middleware/authorization.ts";
import {
  requireOwned,
  updateOwned,
  ownedWhere,
} from "../services/workspace-resource.ts";
import { requireWritableChat } from "../services/chat-write-guard.ts";
import type { Variables } from "../server.ts";
import { rewriteStorageUrls, deleteStoredPrefix } from "../storage/utils.ts";
import { chatStorageKeyPrefix } from "../storage/keys.ts";
import { backendBaseUrl } from "../base-urls.ts";
import { cancelRun } from "../runs/run-cancel.ts";
import { chatRunIsLive } from "../runs/chat-run-heartbeat.ts";
import { CHAT_BUSY_MESSAGE } from "../runs/sinks/chat-sink.ts";
import { startChatTurn } from "../services/chat-turn.ts";
import { normalizeWebToolParts } from "../runs/web-tool-normalize.ts";
import {
  deleteMessage,
  loadActivePath,
  switchActivePath,
  type StoredChatMessage,
} from "../services/chat-messages.ts";
import {
  compactTranscript,
  loadChatSummaries,
  summaryAnchorIndex,
} from "../services/chat-summary.ts";
import { oneRow } from "../db/one-row.ts";

const servedMessages = (messages: StoredChatMessage[], origin: string) =>
  normalizeWebToolParts(
    rewriteStorageUrls(
      messages.map(({ createdAt: _createdAt, ...message }) => message),
      origin,
    ),
  );

const chatResponse = ({
  memorySnapshot: _memorySnapshot,
  lastTurnAt: _lastTurnAt,
  runHeartbeatAt: _runHeartbeatAt,
  memoryCursorId: _memoryCursorId,
  activeLeafId: _activeLeafId,
  a2aTokenId: _a2aTokenId,
  a2aEndpointId: _a2aEndpointId,
  a2aClientName: _a2aClientName,
  triggerRunId: _triggerRunId,
  ...response
}: typeof chatTable.$inferSelect) => response;

const refuseWhileRunning = (chat: Parameters<typeof chatRunIsLive>[0]) => {
  if (chatRunIsLive(chat)) {
    throw new ConflictError(CHAT_BUSY_MESSAGE);
  }
};

const chat = new Hono<{ Variables: Variables }>();

chat.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  validate(
    "query",
    paginationQuerySchema(100).extend({ search: z.string().optional() }),
  ),
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
    const { limit, offset, search } = c.req.valid("query");

    const term = search?.trim().replace(/[\\%_]/g, "\\$&");
    const pattern = `%${term}%`;
    const searchFilter = term
      ? sql`${chatTable.title} ILIKE ${pattern}`
      : undefined;

    const whereClause = and(
      eq(chatTable.workspaceId, workspaceId),
      isNull(chatTable.triggerRunId),
      searchFilter,
    );

    const records = await db
      .select({
        id: chatTable.id,
        title: chatTable.title,
        status: chatTable.status,
        isPinned: chatTable.isPinned,
        agentId: chatTable.agentId,
        providerId: chatTable.providerId,
        modelId: chatTable.modelId,
        a2aClientName: chatTable.a2aClientName,
        createdAt: chatTable.createdAt,
        updatedAt: chatTable.updatedAt,
      })
      .from(chatTable)
      .where(whereClause)
      .orderBy(desc(chatTable.isPinned), desc(chatTable.createdAt))
      .limit(limit)
      .offset(offset);

    const { totalCount } = oneRow(
      await db
        .select({ totalCount: count() })
        .from(chatTable)
        .where(whereClause),
    );

    return c.json({
      results: records.map(({ a2aClientName, ...record }) => ({
        ...record,
        ...(a2aClientName ? { a2aClientName } : {}),
      })),
      totalCount,
    });
  },
);

chat.get(
  "/:chatId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const chatId = c.req.param("chatId");
    const { workspaceId } = workspaceScopeOf(c);

    const chat = await requireOwned(db, "chat", { id: chatId, workspaceId });
    const { messages, tree } = await loadActivePath(chatId, chat.activeLeafId);
    const summaries = await loadChatSummaries(chatId);
    return c.json({
      ...chatResponse(chat),
      ...(chat.a2aClientName ? { a2aClientName: chat.a2aClientName } : {}),
      messages: servedMessages(messages, backendBaseUrl()),
      tree,
      summaries,
    });
  },
);

chat.post(
  "/:chatId/turns",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  validate("json", chatSubmitSchema),
  async (c) => {
    return await startChatTurn({
      scope: workspaceScopeOf(c),
      chatId: c.req.param("chatId"),
      request: c.req.valid("json"),
      includeMemories: true,
      origin: backendBaseUrl(),
    });
  },
);

chat.post(
  "/:chatId/cancel",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  async (c) => {
    const chatId = c.req.param("chatId");
    const { workspaceId } = workspaceScopeOf(c);

    await requireOwned(db, "chat", { id: chatId, workspaceId });

    await cancelRun(chatId);
    return c.json({ message: "Cancellation requested" }, 200);
  },
);

chat.delete(
  "/:chatId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  async (c) => {
    const chatId = c.req.param("chatId");
    const { orgId, workspaceId } = workspaceScopeOf(c);

    await requireWritableChat(db, { id: chatId, workspaceId });

    await db
      .delete(chatTable)
      .where(ownedWhere("chat", { id: chatId, workspaceId }));

    await deleteStoredPrefix(
      chatStorageKeyPrefix({ orgId, workspaceId, chatId }),
    );

    return c.json({ message: "Chat deleted" });
  },
);

chat.delete(
  "/:chatId/messages/:messageId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  async (c) => {
    const { chatId, messageId } = c.req.param();
    const { workspaceId } = workspaceScopeOf(c);

    refuseWhileRunning(
      await requireWritableChat(db, { id: chatId, workspaceId }),
    );

    await deleteMessage(chatId, messageId);

    return c.json({ message: "Message deleted" }, 200);
  },
);

chat.post(
  "/:chatId/compact",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  validate("json", chatCompactSchema),
  async (c) => {
    const chatId = c.req.param("chatId");
    const { orgId, workspaceId } = workspaceScopeOf(c);
    const { instruction } = c.req.valid("json");

    const row = await requireWritableChat(db, { id: chatId, workspaceId });
    refuseWhileRunning(row);

    const { messages } = await loadActivePath(chatId, row.activeLeafId);
    const source = row.agentId
      ? { agentId: row.agentId }
      : row.providerId && row.modelId
        ? { providerId: row.providerId, modelId: row.modelId }
        : undefined;
    if (!source || summaryAnchorIndex(messages, 0) === undefined) {
      throw new ConflictError("There is no completed turn to compact yet");
    }

    const summary = await compactTranscript({
      chatId,
      orgId,
      workspaceId,
      source,
      path: messages,
      instruction,
    });
    if (!summary) {
      throw new UpstreamError("The model could not summarise this Chat");
    }
    return c.json(summary, 201);
  },
);

chat.put(
  "/:chatId/active-leaf",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  validate("json", chatActiveLeafSchema),
  async (c) => {
    const chatId = c.req.param("chatId");
    const { workspaceId } = workspaceScopeOf(c);
    const { messageId } = c.req.valid("json");

    refuseWhileRunning(
      await requireWritableChat(db, { id: chatId, workspaceId }),
    );

    const { messages, tree } = await switchActivePath(chatId, messageId);

    return c.json({
      messages: servedMessages(messages, backendBaseUrl()),
      tree,
    });
  },
);

chat.patch(
  "/:chatId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  validate("json", chatUpdateSchema),
  async (c) => {
    const chatId = c.req.param("chatId");
    const { workspaceId } = workspaceScopeOf(c);
    const { title, isPinned } = c.req.valid("json");

    await requireWritableChat(db, { id: chatId, workspaceId });

    const result = await updateOwned(
      db,
      "chat",
      { id: chatId, workspaceId },
      {
        title,
        isPinned,
        updatedAt: new Date(),
      },
    );

    if (!result) {
      throw new NotFoundError("Chat not found");
    }

    return c.json(chatResponse(result));
  },
);

export { chat };
