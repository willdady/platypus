import { Hono } from "hono";
import { type UIMessage, validateUIMessages } from "ai";
import { openrouter } from "@openrouter/ai-sdk-provider";
import { Experimental_Agent as Agent, stepCountIs } from "ai";
import { getTool } from "../tools/index.ts";

const chat = new Hono();

chat.post("/", async (c) => {
  const { messages, orgId, workspaceId, providerId, modelId } = await c.req.json<
    Promise<{
      messages: UIMessage[];
      orgId: string;
      workspaceId: string;
      providerId: string;
      modelId: string;
    }>
  >();

  // FIXME
  console.log(`GOT PROVIDER: ${providerId}`);
  console.log(`GOT MODEL: ${modelId}`);
  console.log(`GOT ORG: ${orgId}`);
  console.log(`GOT WORKSPACE: ${workspaceId}`);

  const quickChatAgent = new Agent({
    model: openrouter(modelId),
    // FIXME: Tool is just for testing
    tools: {
      convertFahrenheitToCelsius: getTool("convertFahrenheitToCelsius").tool,
    },
    stopWhen: stepCountIs(20),
  });

  return quickChatAgent.respond({
    messages: await validateUIMessages({ messages }),
  });
});

export { chat };
