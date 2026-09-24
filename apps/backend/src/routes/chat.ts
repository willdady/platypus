import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { z } from "zod";
import { db } from "../index.ts";
import { chat as chatTable } from "../db/schema.ts";
import { ConflictError, NotFoundError } from "../errors.ts";
import { chatSubmitSchema, chatUpdateSchema } from "@platypus/schemas";
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
import { agentRunner } from "../runs/agent-runner.ts";
import { runRegistry } from "../runs/run-registry.ts";
import { ChatSink } from "../runs/sinks/chat-sink.ts";
import { normalizeWebToolParts } from "../runs/web-tool-normalize.ts";
import type { RunInput } from "../runs/types.ts";
import { actorUserId } from "../scope.ts";
import {
  formatSummariesForSystemPrompt,
  resolveMemoryPin,
  retrieveRecentSummaries,
} from "../services/memory-retrieval.ts";
import { chatTimeouts } from "../runs/chat-timeouts.ts";
import { seedUserInvokedSkill } from "../services/slash-command.ts";
import {
  deleteMessage,
  loadActivePath,
  resolveTurn,
} from "../services/chat-messages.ts";

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

    const limit = Math.min(parseInt(limitStr ?? "100") || 100, 100);
    const offset = parseInt(offsetStr ?? "0") || 0;

    // Build search filter using ILIKE on title and tags
    const searchFilter =
      search && search.trim() !== ""
        ? or(
            sql`${chatTable.title} ILIKE ${"%" + search.trim() + "%"}`,
            sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${chatTable.tags}) AS t WHERE t ILIKE ${"%" + search.trim() + "%"})`,
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
        createdAt: chatTable.createdAt,
        updatedAt: chatTable.updatedAt,
      })
      .from(chatTable)
      .where(whereClause)
      .orderBy(desc(chatTable.isPinned), desc(chatTable.createdAt))
      .limit(limit)
      .offset(offset);

    const [{ totalCount }] = await db
      .select({ totalCount: count() })
      .from(chatTable)
      .where(whereClause);

    return c.json({ results: records, totalCount });
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

    // The pinned Memories block and previous-turn stamp (ADR-0020), and the
    // active leaf (ADR-0026), are internal — absent from the Chat response
    // schema, never surfaced in the product. Strip them before serialising;
    // the row read by the run sink still carries them.
    const {
      memorySnapshot: _memorySnapshot,
      lastTurnAt: _lastTurnAt,
      activeLeafId,
      ...chatResponse
    } = chat;

    const { messages, tree } = await loadActivePath(chatId, activeLeafId);

    return c.json({
      ...chatResponse,
      // Storage references rewritten to served URLs, and web tool parts
      // normalized — a view over stored data: the Transcript's appearance must
      // not depend on which week it was sent (issue #525), and this is the
      // read-path counterpart to the live stream's normalization in
      // `runs/drive.ts` — no migration, no change to the stored part.
      messages: normalizeWebToolParts(
        rewriteStorageUrls(messages, getOrigin(c)),
      ),
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
    const scope = workspaceScopeOf(c);
    const data = c.req.valid("json");

    // ADR-0020: resolve the pinned Memories block OUTSIDE composition. The
    // Chat route owns the chat row, so it does the arithmetic — compare the gap
    // since the previous turn against the re-pin horizon and re-take or reuse —
    // and the resolved block rides down through `RunInput` into
    // `prepareChatTurn`'s input. The renderer never learns about clocks.
    //
    // Idleness is measured against `lastTurnAt` — stamped only by the run sink
    // at turn boundaries — never `updatedAt`, which the memory-extraction job
    // and auto-titling bump at their own cadence and so cannot stand in for a
    // recent turn.
    const existingChat = await db
      .select({
        memorySnapshot: chatTable.memorySnapshot,
        lastTurnAt: chatTable.lastTurnAt,
      })
      .from(chatTable)
      .where(
        ownedWhere("chat", { id: data.id, workspaceId: scope.workspaceId }),
      )
      .limit(1);

    // What the turn continues, from the server's own rows (ADR-0026). Refuses a
    // turn that cannot run — an unknown parent, a duplicate id, a reply that
    // cannot regenerate — before anything is retrieved or written.
    const turn = await resolveTurn({
      chatId: data.id,
      owned: existingChat.length > 0,
      request: data,
    });

    const now = new Date();
    const pin = resolveMemoryPin({
      existingSnapshot: existingChat[0]?.memorySnapshot,
      previousTurnAt: existingChat[0]?.lastTurnAt,
      now,
    });

    // Reuse carries its own block, so there is no snapshot to assert about: the
    // Chat has not idled past the horizon and the prefix stays byte-identical
    // across its turns. Otherwise re-take — a fresh Chat, a row written before
    // this feature, or a Chat that has idled past the horizon (by which point
    // the cached prefix is provably expired, so the re-take is free). The
    // retrieval window is anchored to `now`, not a render-time clock read.
    const memorySnapshot = pin.reuse
      ? pin.block
      : formatSummariesForSystemPrompt(
          await retrieveRecentSummaries(
            actorUserId(scope.principal),
            scope.workspaceId,
            now,
          ),
        );

    // A user-invoked Skill (issue #649). The token stays in the text the user
    // sent; what is appended here is a trailing assistant message carrying the
    // `loadSkill` call and its result, so the body reaches the model as tool
    // content with correct provenance and never as words the user said.
    //
    // Seeded onto the messages that go into `RunInput` — the array that reaches
    // `originalMessages`, whose trailing assistant message the reply continues
    // and the sink persists. Seeding into the converted model messages instead
    // would reach the model and persist nothing, quietly turning "persist the
    // pair" into "re-seed every turn". A regenerate ends at the same user
    // message, so it is seeded again exactly as its submit was.
    const messages = await seedUserInvokedSkill({
      messages: turn.messages,
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      agentId: data.agentId,
    });

    const input: RunInput = {
      runId: data.id,
      request: data,
      messages,
      memorySnapshot,
      // The same moment the pin was resolved against, so a re-take and its
      // retrieval window agree on "now" rather than reading the clock twice.
      memoriesReferenceDate: now,
    };

    const sink = new ChatSink({
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      message: turn.message,
      parentId: turn.parentId,
    });

    // A rejected attachment (issue #328), an unresolved Agent/Provider/model,
    // or a missing Workspace throws before the sink persists anything, so the
    // chat is never bricked — the central `onError` (ADR-0010) maps the typed
    // error to its HTTP status.
    return await agentRunner.stream({
      scope,
      input,
      sink,
      options: {
        // c.req.raw.signal is intentionally NOT passed: chat runs
        // continue server-side regardless of the client connection.
        // The client cancels via POST /chat/:chatId/cancel.
        origin: getOrigin(c),
        frontendUrl: process.env.FRONTEND_URL,
        timeouts: chatTimeouts(),
      },
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

    // Idempotent: cancel returns false for unknown / already-finished
    // runs, but we still respond 200 so flaky clients can safely retry.
    agentRunner.cancel(chatId);
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

    return c.json({ message: "Chat deleted successfully" }, 200);
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

    await requireOwned(db, "chat", { id: chatId, workspaceId });

    // A turn's reply hangs from the path it started on, and it writes the leaf
    // as it goes — a delete landing mid-run would race it (ADR-0026). A Chat
    // turn runs under its Chat's id.
    if (runRegistry.has(chatId)) {
      throw new ConflictError("A reply is still being written in this Chat");
    }

    await deleteMessage(chatId, messageId);

    return c.json({ message: "Message deleted" }, 200);
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

    // The pinned Memories block (ADR-0020) and the active leaf (ADR-0026) are
    // internal — absent from the Chat response schema, never surfaced in the
    // product. Strip the internal columns before serialising.
    const {
      memorySnapshot: _memorySnapshot,
      lastTurnAt: _lastTurnAt,
      activeLeafId: _activeLeafId,
      ...chatResponse
    } = result;

    return c.json(chatResponse);
  },
);

export { chat };
