import { Hono } from "hono";
import { validate } from "../validate.ts";
import { z } from "zod";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { db } from "../index.ts";
import {
  trigger as triggerTable,
  triggerRun as triggerRunTable,
  triggerRunEvent as triggerRunEventTable,
} from "../db/schema.ts";
import {
  paginationQuerySchema,
  triggerRunStatusSchema,
} from "@platypus/schemas";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
  workspaceScopeOf,
} from "../middleware/authorization.ts";
import { NotFoundError } from "../errors.ts";
import type { Variables } from "../server.ts";

const triggerRun = new Hono<{ Variables: Variables }>();

const listQuerySchema = paginationQuerySchema(50).extend({
  triggerId: z.string().min(1).optional(),
  status: triggerRunStatusSchema.optional(),
});

const detailQuerySchema = z.strictObject({
  sinceSeq: z.coerce.number().int().min(0).optional(),
});

const runRowColumns = {
  id: triggerRunTable.id,
  triggerId: triggerRunTable.triggerId,
  triggerName: triggerTable.name,
  status: triggerRunTable.status,
  eventType: triggerRunTable.eventType,
  eventData: triggerRunTable.eventData,
  startedAt: triggerRunTable.startedAt,
  completedAt: triggerRunTable.completedAt,
  errorMessage: triggerRunTable.errorMessage,
  stats: triggerRunTable.stats,
  unloadedToolSets: triggerRunTable.unloadedToolSets,
  failedToolCalls: triggerRunTable.failedToolCalls,
  createdAt: triggerRunTable.createdAt,
};

triggerRun.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  validate("query", listQuerySchema),
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
    const { triggerId, status, limit, offset } = c.req.valid("query");

    const results = await db
      .select(runRowColumns)
      .from(triggerRunTable)
      .innerJoin(triggerTable, eq(triggerRunTable.triggerId, triggerTable.id))
      .where(
        and(
          eq(triggerTable.workspaceId, workspaceId),
          ...(triggerId ? [eq(triggerRunTable.triggerId, triggerId)] : []),
          ...(status ? [eq(triggerRunTable.status, status)] : []),
        ),
      )
      .orderBy(desc(triggerRunTable.startedAt))
      .limit(limit)
      .offset(offset);

    return c.json({ results });
  },
);

triggerRun.get(
  "/:runId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  validate("query", detailQuerySchema),
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
    const runId = c.req.param("runId");
    const { sinceSeq } = c.req.valid("query");

    const [run] = await db
      .select({
        ...runRowColumns,
        finalText: triggerRunTable.finalText,
        eventsTruncated: triggerRunTable.eventsTruncated,
      })
      .from(triggerRunTable)
      .innerJoin(triggerTable, eq(triggerRunTable.triggerId, triggerTable.id))
      .where(
        and(
          eq(triggerRunTable.id, runId),
          eq(triggerTable.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!run) throw new NotFoundError("Trigger run not found");

    const events = await db
      .select()
      .from(triggerRunEventTable)
      .where(
        and(
          eq(triggerRunEventTable.runId, runId),
          ...(sinceSeq === undefined
            ? []
            : [gt(triggerRunEventTable.seq, sinceSeq)]),
        ),
      )
      .orderBy(asc(triggerRunEventTable.seq));

    return c.json({ run, events });
  },
);

export { triggerRun };
