import { tool } from "ai";
import { z } from "zod";
import { and, desc, eq, gte, isNull, ne, or, sql } from "drizzle-orm";
import {
  CHAT_TRANSCRIPT_PAGE_MAX_BYTES,
  CHAT_TRANSCRIPT_PAGE_MAX_MESSAGES,
  chatStatusSchema,
} from "@platypus/schemas";
import { db } from "../index.ts";
import {
  agent as agentTable,
  chat as chatTable,
  provider as providerTable,
  trigger as triggerTable,
  triggerRun as triggerRunTable,
} from "../db/schema.ts";
import { loadActivePath } from "../services/chat-messages.ts";
import { getStorage } from "../storage/index.ts";
import { chatStorageKeyPrefix, isValidStorageKey } from "../storage/keys.ts";
import {
  canonicalStorageKeyFromUrl,
  decodeDataUrl,
} from "../storage/file-reference.ts";

const NOT_FOUND = "Chat not found";
const OWN_TRANSCRIPT = "A Chat cannot read its own Transcript.";

const attributionSchema = z.object({
  agentName: z.string().optional(),
  providerName: z.string().optional(),
  modelId: z.string().optional(),
});

type ChatAttribution = z.infer<typeof attributionSchema>;

const chatSummarySchema = z
  .object({
    id: z.string(),
    title: z.string(),
    createdAt: z.date(),
    lastTurnAt: z.date().nullable(),
    triggerId: z.string().optional(),
    triggerRunId: z.string().optional(),
    a2aClientName: z.string().optional(),
  })
  .extend(attributionSchema.shape);

const listChatsOutputSchema = z.object({
  chats: z.array(chatSummarySchema),
});

const transcriptHeaderSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    status: chatStatusSchema,
  })
  .extend(attributionSchema.shape);

const transcriptPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("tool-call"),
    toolName: z.string(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    errorText: z.string().optional(),
  }),
  z.object({
    type: z.literal("file"),
    name: z.string().nullable(),
    mediaType: z.string(),
    size: z.number().int().nonnegative().nullable(),
  }),
]);

const transcriptMessageSchema = z.object({
  role: z.string(),
  createdAt: z.date(),
  parts: z.array(transcriptPartSchema),
});

const readTranscriptOutputSchema = z.object({
  chat: transcriptHeaderSchema,
  messages: z.array(transcriptMessageSchema),
  nextCursor: z.string().nullable(),
});

const listChatsInputSchema = z.object({
  agentId: z
    .string()
    .optional()
    .describe("Only Chats last run with this Agent"),
  triggerId: z
    .string()
    .optional()
    .describe("Only Chats kept by runs of this Trigger"),
  since: z.iso
    .datetime()
    .optional()
    .describe(
      "Only Chats whose last turn was at or after this ISO 8601 timestamp",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum number of Chats to return (1-100, default 20)"),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Number of Chats to skip, for paging"),
});

const readTranscriptInputSchema = z.object({
  chatId: z.string().describe("The ID of the Chat to read"),
  cursor: z
    .string()
    .optional()
    .describe(
      "The nextCursor from the previous page. Omit to read from the start.",
    ),
});

type Cursor = { chatId: string; afterId: string };

const encodeCursor = (cursor: Cursor): string =>
  Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");

const decodeCursor = (value: string): Cursor | null => {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<Cursor> | null;
    return typeof parsed?.chatId === "string" &&
      typeof parsed.afterId === "string"
      ? { chatId: parsed.chatId, afterId: parsed.afterId }
      : null;
  } catch {
    return null;
  }
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const fileSize = async (
  url: unknown,
  chatPrefix: string,
): Promise<number | null> => {
  if (typeof url !== "string") return null;
  const inline = decodeDataUrl(url);
  if (inline) return inline.bytes.length;

  const key = canonicalStorageKeyFromUrl(url);
  if (!key || !isValidStorageKey(key) || !key.startsWith(chatPrefix)) {
    return null;
  }
  try {
    const stored = await getStorage().getStream(key);
    if (!stored) return null;
    stored.stream.destroy();
    return stored.contentLength;
  } catch {
    return null;
  }
};

const toolNameOf = (type: string, part: Record<string, unknown>): string =>
  type === "dynamic-tool"
    ? typeof part.toolName === "string"
      ? part.toolName
      : "unknown"
    : type.slice("tool-".length);

const transcriptPart = async (
  value: unknown,
  chatPrefix: string,
): Promise<z.infer<typeof transcriptPartSchema> | null> => {
  const part = asRecord(value);
  const type = typeof part.type === "string" ? part.type : "";

  if (type === "text") {
    return {
      type: "text",
      text: typeof part.text === "string" ? part.text : "",
    };
  }
  if (type === "reasoning") return null;

  if (type === "file") {
    return {
      type: "file",
      name: typeof part.filename === "string" ? part.filename : null,
      mediaType:
        typeof part.mediaType === "string"
          ? part.mediaType
          : "application/octet-stream",
      size: await fileSize(part.url, chatPrefix),
    };
  }

  if (type === "dynamic-tool" || type.startsWith("tool-")) {
    return {
      type: "tool-call",
      toolName: toolNameOf(type, part),
      ...(part.input === undefined ? {} : { input: part.input }),
      ...(part.output === undefined ? {} : { output: part.output }),
      ...(typeof part.errorText === "string"
        ? { errorText: part.errorText }
        : {}),
    };
  }

  return null;
};

const attributionOf = (row: {
  agentName: string | null;
  providerName: string | null;
  modelId: string | null;
}): ChatAttribution =>
  row.agentName
    ? { agentName: row.agentName }
    : {
        ...(row.providerName ? { providerName: row.providerName } : {}),
        ...(row.modelId ? { modelId: row.modelId } : {}),
      };

export const createChatTools = (
  orgId: string,
  workspaceId: string,
  sessionId: string,
) => {
  const listChats = tool({
    description:
      "List the Chats in this workspace, newest activity first, with an optional Agent, Trigger or time filter. Use readTranscript to read one.",
    inputSchema: listChatsInputSchema,
    execute: async ({ agentId, triggerId, since, limit, offset }) => {
      const pageSize = limit ?? 20;
      const skip = offset ?? 0;

      const where = and(
        eq(chatTable.workspaceId, workspaceId),
        ne(chatTable.id, sessionId),
        or(
          isNull(chatTable.triggerRunId),
          ne(chatTable.triggerRunId, sessionId),
        ),
        ...(agentId ? [eq(chatTable.agentId, agentId)] : []),
        ...(triggerId ? [eq(triggerTable.id, triggerId)] : []),
        ...(since ? [gte(chatTable.lastTurnAt, new Date(since))] : []),
      );

      const rows = await db
        .select({
          id: chatTable.id,
          title: chatTable.title,
          createdAt: chatTable.createdAt,
          lastTurnAt: chatTable.lastTurnAt,
          agentName: agentTable.name,
          providerName: providerTable.name,
          modelId: chatTable.modelId,
          triggerRunId: chatTable.triggerRunId,
          a2aClientName: chatTable.a2aClientName,
          triggerId: triggerTable.id,
        })
        .from(chatTable)
        .leftJoin(agentTable, eq(agentTable.id, chatTable.agentId))
        .leftJoin(providerTable, eq(providerTable.id, chatTable.providerId))
        .leftJoin(
          triggerRunTable,
          eq(triggerRunTable.id, chatTable.triggerRunId),
        )
        .leftJoin(triggerTable, eq(triggerTable.id, triggerRunTable.triggerId))
        .where(where)
        .orderBy(
          sql`${chatTable.lastTurnAt} desc nulls last`,
          desc(chatTable.createdAt),
          desc(chatTable.id),
        )
        .limit(pageSize)
        .offset(skip);

      return listChatsOutputSchema.parse({
        chats: rows.map((row) => ({
          id: row.id,
          title: row.title,
          createdAt: row.createdAt,
          lastTurnAt: row.lastTurnAt,
          ...attributionOf(row),
          ...(row.triggerId ? { triggerId: row.triggerId } : {}),
          ...(row.triggerRunId ? { triggerRunId: row.triggerRunId } : {}),
          ...(row.a2aClientName ? { a2aClientName: row.a2aClientName } : {}),
        })),
      });
    },
  });

  const readTranscript = tool({
    description:
      "Read one page of a Chat's Transcript, oldest message first. Pass the returned nextCursor to read the next page.",
    inputSchema: readTranscriptInputSchema,
    execute: async ({ chatId, cursor }) => {
      const [row] = await db
        .select({
          id: chatTable.id,
          title: chatTable.title,
          status: chatTable.status,
          activeLeafId: chatTable.activeLeafId,
          triggerRunId: chatTable.triggerRunId,
          agentName: agentTable.name,
          providerName: providerTable.name,
          modelId: chatTable.modelId,
        })
        .from(chatTable)
        .leftJoin(agentTable, eq(agentTable.id, chatTable.agentId))
        .leftJoin(providerTable, eq(providerTable.id, chatTable.providerId))
        .where(
          and(eq(chatTable.id, chatId), eq(chatTable.workspaceId, workspaceId)),
        )
        .limit(1);

      if (!row) return { error: NOT_FOUND };
      if (row.id === sessionId || row.triggerRunId === sessionId) {
        return { error: OWN_TRANSCRIPT };
      }

      const decoded = cursor ? decodeCursor(cursor) : null;
      if (cursor && (!decoded || decoded.chatId !== row.id)) {
        return {
          error:
            "Invalid cursor. Call readTranscript again without a cursor to start from the beginning.",
        };
      }

      const { messages } = await loadActivePath(row.id, row.activeLeafId);
      const chatPrefix = chatStorageKeyPrefix({
        orgId,
        workspaceId,
        chatId: row.id,
      });

      let start = 0;
      if (decoded) {
        const index = messages.findIndex(
          (message) => message.id === decoded.afterId,
        );
        if (index === -1) {
          return {
            error:
              "The cursor no longer matches this Chat's Active path. Call readTranscript again without a cursor to start from the beginning.",
          };
        }
        start = index + 1;
      }

      const page: z.infer<typeof transcriptMessageSchema>[] = [];
      let bytes = 0;
      let end = start;
      let lastIncludedId: string | null = null;
      for (; end < messages.length; end++) {
        if (page.length >= CHAT_TRANSCRIPT_PAGE_MAX_MESSAGES) break;

        const message = messages[end];
        if (!message) break;
        const parts = (
          await Promise.all(
            message.parts.map((part) => transcriptPart(part, chatPrefix)),
          )
        ).filter(
          (part): part is z.infer<typeof transcriptPartSchema> => part !== null,
        );
        const shaped = {
          role: message.role,
          createdAt: message.createdAt,
          parts,
        };
        const size = Buffer.byteLength(JSON.stringify(shaped), "utf8");

        if (page.length > 0 && bytes + size > CHAT_TRANSCRIPT_PAGE_MAX_BYTES) {
          break;
        }
        page.push(shaped);
        bytes += size;
        lastIncludedId = message.id;
      }

      return readTranscriptOutputSchema.parse({
        chat: {
          id: row.id,
          title: row.title,
          status: row.status,
          ...attributionOf(row),
        },
        messages: page,
        nextCursor:
          end < messages.length && lastIncludedId
            ? encodeCursor({ chatId: row.id, afterId: lastIncludedId })
            : null,
      });
    },
  });

  return { listChats, readTranscript };
};
