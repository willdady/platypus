import { Hono } from 'hono';
import { sValidator } from '@hono/standard-validator';
import { nanoid } from 'nanoid';
import { db } from '../index.ts';
import { tool as toolTable } from '../db/schema.ts';
import { toolCreateSchema, toolUpdateSchema } from '@agent-kit/schemas';
import { eq } from 'drizzle-orm';

const tool = new Hono();

/** Create a new tool */
tool.post(
  '/',
  sValidator('json', toolCreateSchema),
  async (c) => {
    const data = c.req.valid('json');
    const record = await db.insert(toolTable).values({
      id: nanoid(),
      ...data,
    }).returning();
    return c.json(record, 201);
  },
);

/** List all tools */
tool.get('/', async (c) => {
  const results = await db
    .select()
    .from(toolTable);
  return c.json({ results });
});

/** Get a tool by ID */
tool.get('/:id', async (c) => {
  const id = c.req.param('id');
  const record = await db
    .select()
    .from(toolTable)
    .where(eq(toolTable.id, id))
    .limit(1);
  if (record.length === 0) {
    return c.json({ message: 'Tool not found' }, 404);
  }
  return c.json(record[0]);
});

/** Update a tool by ID */
tool.put('/:id', sValidator('json', toolUpdateSchema), async (c) => {
  const id = c.req.param('id');
  const data = c.req.valid('json');
  const record = await db.update(toolTable).set({
    ...data,
    updatedAt: new Date(),
  }).where(eq(toolTable.id, id)).returning();
  return c.json(record, 200);
});

/** Delete a tool by ID */
tool.delete('/:id', async (c) => {
  const id = c.req.param('id');
  await db.delete(toolTable).where(eq(toolTable.id, id));
  return c.json({ message: 'Tool deleted' });
});

export { tool };