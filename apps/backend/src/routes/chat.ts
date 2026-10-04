import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { z } from "zod";
import { db } from "../index.ts";
import { a2aToken as a2aTokenTable, chat as chatTable } from "../db/schema.ts";
import { ConflictError, NotFoundError } from "../errors.ts";
import {
  chatActiveLeafSchema,
  chatSubmitSchema,
  chatUpdateSchema,
} from "@platypus/schemas";
import { and, count, desc, eq, or, sql } from "drizzle-orm";
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
import type { Variables } from "../server.ts";
import { rewriteStorageUrls, deleteStoredPrefix } from "../storage/utils.ts";
import { chatStorageKeyPrefix } from "../storage/keys.ts";
import { getOrigin } from "../utils/get-origin.ts";
import { cancelRun } from "../runs/run-cancel.ts";
import { CHAT_BUSY_MESSAGE } from "../runs/sinks/chat-sink.ts";
import { startChatTurn } from "../services/chat-turn.ts";
import { normalizeWebToolParts } from "../runs/web-tool-normalize.ts";
import {
  deleteMessage,
  loadActivePath,
  switchActivePath,
} from "../services/chat-messages.ts";
import type { PlatypusUIMessage } from "../types.ts";

/**
 * Stored messages as a reader gets them: storage references rewritten to
 * served URLs, and web tool parts normalized — a view over stored data: the
 * Transcript's appearance must not depend on which week it was sent (issue
 * #525), and this is the read-path counterpart to the live stream's
 * normalization in `runs/drive.ts` — no migration, no change to the stored
 * part.
 */
const servedMessages = (messages: PlatypusUIMessage[], origin: string) =>
  normalizeWebToolParts(rewriteStorageUrls(messages, origin));

/**
 * A Chat row as a reader gets it. The pinned Memories block and previous-turn
 * stamp (ADR-0020), the active leaf (ADR-0026) and the memory extraction
 * cursor are internal — absent from the Chat response schema, never surfaced
 * in the product. The row read by the run sink still carries them.
 */
const chatResponse = ({
  memorySnapshot: _memorySnapshot,
  lastTurnAt: _lastTurnAt,
  memoryCursorId: _memoryCursorId,
  activeLeafId: _activeLeafId,
  a2aTokenId: _a2aTokenId,
  ...response
}: typeof chatTable.$inferSelect) => response;

/**
 * A run moves the leaf onto its own reply as it goes, and a delete or a switch
 * landing mid-run would race it (ADR-0026). Read from the row the run claimed,
 * since the run may be another instance's (#1237).
 */
const refuseWhileRunning = (chat: { status: string }) => {
  if (chat.status === "running") {
    throw new ConflictError(CHAT_BUSY_MESSAGE);
  }
};

// --- Routes ---

const chat = new Hono<{ Variables: Variables }>();

chat.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  sValidator(
    "query",
    z.object({
      limit: z.string().optional(),
      offset: z.string().optional(),
      search: z.string().optional(),
    }),
  ),
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
    const { limit: limitStr, offset: offsetStr, search } = c.req.valid("query");

    const limit = Math.min(
      Math.max(parseInt(limitStr ?? "100") || 100, 1),
      100,
    );
    const offset = Math.max(parseInt(offsetStr ?? "0") || 0, 0);

    // Build search filter using ILIKE on title and tags. `\` is Postgres's
    // default LIKE escape, so escaping `%`, `_` and `\` matches them literally.
    const term = search?.trim().replace(/[\\%_]/g, "\\$&");
    const pattern = `%${term}%`;
    const searchFilter = term
      ? or(
          sql`${chatTable.title} ILIKE ${pattern}`,
          sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${chatTable.tags}) AS t WHERE t ILIKE ${pattern})`,
        )
      : undefined;

    const whereClause = and(
      eq(chatTable.workspaceId, workspaceId),
      searchFilter,
    );

    const records = await db
      .select({
        id: chatTable.id,
        title: chatTable.title,
        status: chatTable.status,
        isPinned: chatTable.isPinned,
        tags: chatTable.tags,
        agentId: chatTable.agentId,
        providerId: chatTable.providerId,
        modelId: chatTable.modelId,
        a2aClientName: a2aTokenTable.name,
        createdAt: chatTable.createdAt,
        updatedAt: chatTable.updatedAt,
      })
      .from(chatTable)
      .leftJoin(a2aTokenTable, eq(a2aTokenTable.id, chatTable.a2aTokenId))
      .where(whereClause)
      .orderBy(desc(chatTable.isPinned), desc(chatTable.createdAt))
      .limit(limit)
      .offset(offset);

    const [{ totalCount }] = await db
      .select({ totalCount: count() })
      .from(chatTable)
      .where(whereClause);

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
    const [a2aToken] = chat.a2aTokenId
      ? await db
          .select({ name: a2aTokenTable.name })
          .from(a2aTokenTable)
          .where(eq(a2aTokenTable.id, chat.a2aTokenId))
      : [];

    return c.json({
      ...chatResponse(chat),
      ...(a2aToken ? { a2aClientName: a2aToken.name } : {}),
      messages: servedMessages(messages, getOrigin(c)),
      tree,
    });
  },
);

chat.post(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  sValidator("json", chatSubmitSchema),
  async (c) => {
    // An interactive turn always includes the Owner's Memories.
    return await startChatTurn({
      scope: workspaceScopeOf(c),
      request: c.req.valid("json"),
      includeMemories: true,
      origin: getOrigin(c),
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

    // Verify the chat belongs to this workspace before signalling cancel.
    // This is what makes a cross-workspace cancel return 404 rather than
    // silently no-op — runIds (which equal chat IDs) are otherwise the
    // only thing the registry sees.
    await requireOwned(db, "chat", { id: chatId, workspaceId });

    // Idempotent: an unknown or already-finished run is a no-op, but we still
    // respond 200 so flaky clients can safely retry. The run may be another
    // instance's, so this reaches whichever holds it (#1237).
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

    await requireOwned(db, "chat", { id: chatId, workspaceId });

    await db
      .delete(chatTable)
      .where(ownedWhere("chat", { id: chatId, workspaceId }));

    // By prefix, not by the keys the messages reference: files on messages off
    // the Active path — Alternatives, deleted messages — are stored too.
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
      await requireOwned(db, "chat", { id: chatId, workspaceId }),
    );

    await deleteMessage(chatId, messageId);

    return c.json({ message: "Message deleted" }, 200);
  },
);

chat.put(
  "/:chatId/active-leaf",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  sValidator("json", chatActiveLeafSchema),
  async (c) => {
    const chatId = c.req.param("chatId");
    const { workspaceId } = workspaceScopeOf(c);
    const { messageId } = c.req.valid("json");

    refuseWhileRunning(
      await requireOwned(db, "chat", { id: chatId, workspaceId }),
    );

    const { messages, tree } = await switchActivePath(chatId, messageId);

    return c.json({ messages: servedMessages(messages, getOrigin(c)), tree });
  },
);

chat.put(
  "/:chatId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  sValidator("json", chatUpdateSchema),
  async (c) => {
    const chatId = c.req.param("chatId");
    const { workspaceId } = workspaceScopeOf(c);
    const { title, isPinned, tags } = c.req.valid("json");

    const result = await updateOwned(
      db,
      "chat",
      { id: chatId, workspaceId },
      {
        title,
        isPinned,
        tags,
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
