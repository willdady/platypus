import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../index.ts";
import {
  trigger as triggerTable,
  triggerRun as triggerRunTable,
} from "../db/schema.ts";
import { triggerRunStatusSchema } from "@platypus/schemas";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
  workspaceScopeOf,
} from "../middleware/authorization.ts";
import { ValidationError } from "../errors.ts";
import type { Variables } from "../server.ts";

/**
 * Trigger runs at Workspace scope: one listing across every Trigger in the
 * Workspace, which is the only shape that can order and page correctly over a
 * mixed set. It replaces the per-Trigger `/triggers/:triggerId/runs` listing —
 * the `triggerId` filter below covers that ground.
 */
const triggerRun = new Hono<{ Variables: Variables }>();

/**
 * The listing's query parameters. A value the schema rejects — a status the
 * domain does not have, an unreadable or out-of-range page — fails the request
 * rather than falling back to a default or dropping the filter, either of which
 * would render a list that lies about what it is filtered to. Absent is
 * different from invalid: an omitted `limit`/`offset` takes the default below.
 */
const listQuerySchema = z.object({
  triggerId: z.string().min(1).optional(),
  status: triggerRunStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** List runs across the workspace, newest first. */
triggerRun.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  // The validator's own 400 body is not the shape this API answers with, so a
  // rejected query becomes a `ValidationError` and takes the central error seam
  // like every other 400 (ADR-0010).
  sValidator("query", listQuerySchema, (result) => {
    if (!result.success) {
      throw new ValidationError(
        `Invalid query parameters: ${result.error
          .map((issue) => {
            // Name the offending parameter — "Too big" alone leaves a caller
            // guessing which of `limit` and `offset` it meant.
            const path = (issue.path ?? [])
              .map((segment) =>
                String(
                  typeof segment === "object" && segment !== null
                    ? segment.key
                    : segment,
                ),
              )
              .join(".");
            return path ? `${path}: ${issue.message}` : issue.message;
          })
          .join("; ")}`,
      );
    }
  }),
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
    const { triggerId, status, limit, offset } = c.req.valid("query");

    // Joining each run to its Trigger is what scopes the listing: a run whose
    // Trigger lives in another Workspace is unreachable here regardless of the
    // `triggerId` asked for. The join also carries the Trigger's name, which
    // every row needs now the list mixes Triggers.
    const results = await db
      .select({
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
        createdAt: triggerRunTable.createdAt,
      })
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

export { triggerRun };
