import { Hono } from "hono";
import { type UIMessage, validateUIMessages } from "ai";
import { generalAgent } from "../agents/general.ts";

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

  return generalAgent.respond({
    messages: await validateUIMessages({ messages }),
  });
});

export { chat };
