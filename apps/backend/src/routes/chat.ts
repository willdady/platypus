import { Hono } from 'hono';
import { type UIMessage, validateUIMessages } from 'ai';
import { generalAgent } from '../agents/general.ts';


const chat = new Hono();

chat.post('/', async (c) => {
  const { messages } = await c.req.json<Promise<{ messages: UIMessage[] }>>();

  return generalAgent.respond({
    messages: await validateUIMessages({ messages }),
  });
});

export { chat };