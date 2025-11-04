import { Hono } from 'hono';

const tool = new Hono();

/** List all tools */
tool.get('/', async (c) => {
  // FIXME
  return c.json({ results: [] });
});

export { tool };