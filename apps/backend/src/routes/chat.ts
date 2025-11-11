import { Hono } from "hono";
import { type UIMessage, validateUIMessages } from "ai";
import { openrouter } from "@openrouter/ai-sdk-provider";
import { Experimental_Agent as Agent, stepCountIs } from "ai";
import { getTool } from "../tools/index.ts";

const chat = new Hono();

chat.post("/", async (c) => {
  const { messages, model, orgId, workspaceId } = await c.req.json<
    Promise<{
      messages: UIMessage[];
      model: string;
      orgId: string;
      workspaceId: string;
    }>
  >();

  // FIXME
  console.log(`GOT MODEL: ${model}`);
  console.log(`GOT ORG: ${orgId}`);
  console.log(`GOT WORKSPACE: ${workspaceId}`);

  const quickChatAgent = new Agent({
    model: openrouter(model),
    // FIXME: Tool is just for testing
    tools: {
      convertFahrenheitToCelsius: getTool('convertFahrenheitToCelsius')
    },
    stopWhen: stepCountIs(20),
  });

  return quickChatAgent.respond({
    messages: await validateUIMessages({ messages }),
  });
});

export { chat };
