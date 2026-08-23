import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { z } from "zod";
import { db } from "../index.ts";
import { chat as chatTable } from "../db/schema.ts";
import { NotFoundError } from "../errors.ts";
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
import { type PlatypusUIMessage } from "../types.ts";
import { rewriteStorageUrls, deleteFiles } from "../storage/utils.ts";
import { getOrigin } from "../utils/get-origin.ts";
import { agentRunner } from "../runs/agent-runner.ts";
import { ChatSink } from "../runs/sinks/chat-sink.ts";
import type { RunInput } from "../runs/types.ts";
import { actorUserId } from "../scope.ts";
import {
  formatSummariesForSystemPrompt,
  resolveMemoryPin,
  retrieveRecentSummaries,
} from "../services/memory-retrieval.ts";

/**
 * The bounds an interactive Chat run is given.
 *
 * Chat used to take the registry's own defaults, which are deliberately tight
 * because they are what an unbounded caller falls back to. That gave a watched
 * conversation a 10-minute ceiling — shorter than a long agentic turn — and no
 * way for an Operator to raise it (issue #552).
 *
 * The per-step bound is an idle timeout: time with no streamed chunk at all,
 * not time spent on one step. Two minutes of complete silence from a provider
 * is a stall worth acting on; a long answer is not, and no longer trips it.
 *
 * Override via env:
 *  - `CHAT_PER_STEP_TIMEOUT_MS` (default 2 min)
 *  - `CHAT_PER_RUN_TIMEOUT_MS` (default 30 min)
 */
const DEFAULT_CHAT_PER_STEP_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_CHAT_PER_RUN_TIMEOUT_MS = 30 * 60 * 1000;

const chatTimeouts = () => ({
  perStepTimeoutMs: parseInt(
    process.env.CHAT_PER_STEP_TIMEOUT_MS ??
      String(DEFAULT_CHAT_PER_STEP_TIMEOUT_MS),
  ),
  perRunTimeoutMs: parseInt(
    process.env.CHAT_PER_RUN_TIMEOUT_MS ??
      String(DEFAULT_CHAT_PER_RUN_TIMEOUT_MS),
  ),
});

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

    const chat = await requireOwned(db, "chat", chatId, workspaceId);

    // The pinned Memories block and previous-turn stamp (ADR-0020) are internal
    // — absent from the Chat response schema, never surfaced in the product.
    // Strip them before serialising; the row read by the run sink still carries
    // them.
    const {
      memorySnapshot: _memorySnapshot,
      lastTurnAt: _lastTurnAt,
      ...chatResponse
    } = chat;

    // Rewrite storage:// URLs to HTTP URLs
    const origin = getOrigin(c);
    if (chatResponse.messages) {
      chatResponse.messages = rewriteStorageUrls(
        chatResponse.messages as PlatypusUIMessage[],
        origin,
      );
    }

    return c.json(chatResponse);
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
      .where(ownedWhere("chat", data.id, scope.workspaceId))
      .limit(1);
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

    const input: RunInput = {
      runId: data.id,
      request: data,
      messages: (data.messages as PlatypusUIMessage[] | undefined) ?? [],
      memorySnapshot,
      // The same moment the pin was resolved against, so a re-take and its
      // retrieval window agree on "now" rather than reading the clock twice.
      memoriesReferenceDate: now,
    };

    const sink = new ChatSink({
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
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
    await requireOwned(db, "chat", chatId, workspaceId);

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
    const { workspaceId } = workspaceScopeOf(c);

    // First fetch the chat to get its messages for file cleanup
    const chatRecord = await requireOwned(db, "chat", chatId, workspaceId);

    // Delete associated files from storage (best-effort)
    if (chatRecord.messages) {
      await deleteFiles(chatRecord.messages as PlatypusUIMessage[]);
    }

    // Delete the chat record
    await db.delete(chatTable).where(ownedWhere("chat", chatId, workspaceId));

    return c.json({ message: "Chat deleted successfully" }, 200);
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

    const result = await updateOwned(db, "chat", chatId, workspaceId, {
      title,
      isPinned,
      tags,
      updatedAt: new Date(),
    });

    if (!result) {
      throw new NotFoundError("Chat not found");
    }

    // The pinned Memories block (ADR-0020) is internal — absent from the Chat
    // response schema, never surfaced in the product. Strip the internal
    // columns (`memorySnapshot`, `lastTurnAt`) before serialising.
    const {
      memorySnapshot: _memorySnapshot,
      lastTurnAt: _lastTurnAt,
      ...chatResponse
    } = result;

    return c.json(chatResponse);
  },
);

export { chat };
