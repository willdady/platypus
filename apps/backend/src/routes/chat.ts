import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import {
  convertToModelMessages,
  type LanguageModel,
  streamText,
  type UIMessage,
} from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { stepCountIs } from "ai";
import { db } from "../index.ts";
import { chat as chatTable, provider as providerTable } from "../db/schema.ts";
import { chatUpdateSchema } from "@agent-kit/schemas";
import { and, eq } from "drizzle-orm";

const chat = new Hono();

chat.get("/:id", async (c) => {
  const id = c.req.param("id");
  const workspaceId = c.req.query("workspaceId");

  if (!workspaceId) {
    return c.json({ message: "workspaceId query parameter is required" }, 400);
  }

  const record = await db
    .select()
    .from(chatTable)
    .where(and(eq(chatTable.id, id), eq(chatTable.workspaceId, workspaceId)))
    .limit(1);
  if (record.length === 0) {
    return c.json({ message: "Chat not found" }, 404);
  }
  return c.json(record[0]);
});

chat.post("/", sValidator("json", chatUpdateSchema), async (c) => {
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

export { chat };
