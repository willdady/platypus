import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { z } from "zod";
import { convertToModelMessages, type LanguageModel, streamText, generateObject, type UIMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { stepCountIs } from "ai";
import { db } from "../index.ts";
import { chat as chatTable, provider as providerTable } from "../db/schema.ts";
import { chatSubmitSchema, chatUpdateSchema, chatGenerateTitleSchema } from "@agent-kit/schemas";
import { and, eq, desc } from "drizzle-orm";

const chat = new Hono();

chat.get(
  "/",
  sValidator(
    "query",
    z.object({
      workspaceId: z.string(),
      limit: z.string().optional(),
      offset: z.string().optional(),
    }),
  ),
  async (c) => {
    const {
      workspaceId,
      limit: limitStr,
      offset: offsetStr,
    } = c.req.valid("query");

    if (!workspaceId) {
      return c.json(
        { message: "workspaceId query parameter is required" },
        400,
      );
    }

    const limit = Math.min(parseInt(limitStr ?? "100") || 100, 100);
    const offset = parseInt(offsetStr ?? "0") || 0;

    const records = await db
      .select({
        id: chatTable.id,
        title: chatTable.title,
        isStarred: chatTable.isStarred,
        createdAt: chatTable.createdAt,
        updatedAt: chatTable.updatedAt,
      })
      .from(chatTable)
      .where(eq(chatTable.workspaceId, workspaceId))
      .orderBy(desc(chatTable.createdAt))
      .limit(limit)
      .offset(offset);

    return c.json({ results: records });
  },
);

chat.get(
  "/:id",
  sValidator("query", z.object({ workspaceId: z.string() })),
  async (c) => {
    const id = c.req.param("id");
    const { workspaceId } = c.req.valid("query");

    const record = await db
      .select()
      .from(chatTable)
      .where(and(eq(chatTable.id, id), eq(chatTable.workspaceId, workspaceId)))
      .limit(1);
    if (record.length === 0) {
      return c.json({ message: "Chat not found" }, 404);
    }
    return c.json(record[0]);
  },
);

chat.post("/", sValidator("json", chatSubmitSchema), async (c) => {
  const data = c.req.valid("json");
  
  const { id, workspaceId, providerId, modelId, messages = [] } = data;

  // Get the provider record from the database
  const providerRecord = await db
    .select()
    .from(providerTable)
    .where(
      and(
        eq(providerTable.id, providerId),
        eq(providerTable.workspaceId, workspaceId),
      ),
    )
    .limit(1);

  if (providerRecord.length === 0) {
    throw new Error(`Provider with id '${providerId}' not found`);
  }
  const provider = providerRecord[0];

  // Check the received modelId is enabled/defined on the provider
  if (!provider.modelIds.includes(modelId)) {
    throw new Error(
      `Model id '${modelId}' not enabled for provider '${providerId}'`,
    );
  }

  let model: LanguageModel;
  if (provider.providerType === "OpenAI") {
    // NOTE: the OpenAI provider uses the Responses API by default
    const openai = createOpenAI({
      baseURL: provider.baseUrl ?? undefined,
      apiKey: provider.apiKey ?? undefined,
      headers: provider.headers ?? undefined,
    });
    model = openai(modelId);
  } else if (provider.providerType === "OpenRouter") {
    const openRouter = createOpenRouter({
      baseURL: provider.baseUrl ?? undefined,
      apiKey: provider.apiKey ?? undefined,
      headers: provider.headers ?? undefined,
    });
    model = openRouter(modelId);
  } else {
    throw new Error(`Unrecognized provider type '${provider.providerType}'`);
  }

  // Stream chat response to client
  const result = streamText({
    model,
    messages: convertToModelMessages(messages),
    stopWhen: stepCountIs(20),
  });

  return result.toUIMessageStreamResponse({
    originalMessages: messages,
    onFinish: async ({ messages }) => {
      try {
        // Upsert chat record - try update first, then insert if not found
        const updateResult = await db
          .update(chatTable)
          .set({
            messages,
            updatedAt: new Date(),
          })
          .where(
            and(eq(chatTable.id, id), eq(chatTable.workspaceId, workspaceId)),
          )
          .returning();

        // If no rows were updated, insert the record
        if (updateResult.length === 0) {
          await db.insert(chatTable).values({
            id,
            workspaceId,
            title: "Untitled",
            messages,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }

        console.log(
          `Successfully upserted chat '${id}' in workspace '${workspaceId}'`,
        );
      } catch (error) {
        console.error(
          `Error upserting chat '${id}' in workspace '${workspaceId}':`,
        );
        console.error(error);
      }
    },
  });
});

chat.delete(
  "/:id",
  sValidator("query", z.object({ workspaceId: z.string() })),
  async (c) => {
    const id = c.req.param("id");
    const { workspaceId } = c.req.valid("query");

    const result = await db
      .delete(chatTable)
      .where(and(eq(chatTable.id, id), eq(chatTable.workspaceId, workspaceId)))
      .returning();

    if (result.length === 0) {
      return c.json({ message: "Chat not found" }, 404);
    }

    return c.json({ message: "Chat deleted successfully" }, 200);
  },
);

chat.put(
  "/:id",
  sValidator("query", z.object({ workspaceId: z.string() })),
  sValidator("json", chatUpdateSchema),
  async (c) => {
    const id = c.req.param("id");
    const { workspaceId } = c.req.valid("query");
    const { title, isStarred } = c.req.valid("json");

    const result = await db
      .update(chatTable)
      .set({ title, isStarred, updatedAt: new Date() })
      .where(and(eq(chatTable.id, id), eq(chatTable.workspaceId, workspaceId)))
      .returning();

    if (result.length === 0) {
      return c.json({ message: "Chat not found" }, 404);
    }

    return c.json(result[0]);
  },
);

chat.post(
  "/:id/generate-title",
  sValidator("query", z.object({ workspaceId: z.string() })),
  sValidator("json", chatGenerateTitleSchema),
  async (c) => {
    const id = c.req.param("id");
    const { workspaceId } = c.req.valid("query");
    const { providerId } = c.req.valid("json");

    // Fetch chat record
    const chatRecord = await db
      .select()
      .from(chatTable)
      .where(and(eq(chatTable.id, id), eq(chatTable.workspaceId, workspaceId)))
      .limit(1);
    if (chatRecord.length === 0) {
      return c.json({ message: "Chat not found" }, 404);
    }
    const chat = chatRecord[0];

    // Fetch provider record
    const providerRecord = await db
      .select()
      .from(providerTable)
      .where(
        and(
          eq(providerTable.id, providerId),
          eq(providerTable.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (providerRecord.length === 0) {
      return c.json({ message: "Provider not found" }, 404);
    }
    const provider = providerRecord[0];

    // Instantiate model
    let model: LanguageModel;
    if (provider.providerType === "OpenAI") {
      const openai = createOpenAI({
        baseURL: provider.baseUrl ?? undefined,
        apiKey: provider.apiKey ?? undefined,
        headers: provider.headers ?? undefined,
      });
      model = openai(provider.taskModelId);
    } else if (provider.providerType === "OpenRouter") {
      const openRouter = createOpenRouter({
        baseURL: provider.baseUrl ?? undefined,
        apiKey: provider.apiKey ?? undefined,
        headers: provider.headers ?? undefined,
      });
      model = openRouter(provider.taskModelId);
    } else {
      throw new Error(`Unrecognized provider type '${provider.providerType}'`);
    }

    // Generate title
    const messages = (chat.messages as UIMessage[]) || [];
    const conversationText = messages
      .map((m) => {
        const message = m.parts.map(p => {
          if (p.type === 'text') return p.text;
          return '';
        });
        return `${m.role}:\n${message.join("")}`;
      })
      .join("\n");

    const result = await generateObject({
      model,
      schema: z.object({ title: z.string() }),
      prompt: [
        `Generate a short, descriptive title for this chat conversation. You may use at most one emoji and must not exceed 30 characters.\n`,
        `Conversation:\n${conversationText}`
      ].join("\n"),
    });

    const newTitle = result.object.title;

    // Update chat title
    const updateResult = await db
      .update(chatTable)
      .set({ title: newTitle, updatedAt: new Date() })
      .where(and(eq(chatTable.id, id), eq(chatTable.workspaceId, workspaceId)))
      .returning();

    return c.json(updateResult[0]);
  },
);

export { chat };
