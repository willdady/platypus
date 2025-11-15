import { Hono } from "hono";
import {
  type LanguageModel,
  type UIMessage,
  streamText,
  convertToModelMessages,
} from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { stepCountIs } from "ai";
import { db } from "../index.ts";
import { provider as providerTable } from "../db/schema.ts";
import { eq, and } from "drizzle-orm";

const chat = new Hono();

chat.post("/", async (c) => {
  const { messages, orgId, workspaceId, providerId, modelId } =
    await c.req.json<
      Promise<{
        messages: UIMessage[];
        orgId: string;
        workspaceId: string;
        providerId: string;
        modelId: string;
      }>
    >();

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
      `Model id ${modelId} not enabled for provider ${providerId}`,
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

  const result = streamText({
    model,
    messages: convertToModelMessages(messages),
    stopWhen: stepCountIs(20),
  });

  return result.toUIMessageStreamResponse();
});

export { chat };
