import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { z } from "zod";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { db } from "../index.ts";
import {
  trigger as triggerTable,
  triggerRun as triggerRunTable,
  triggerRunEvent as triggerRunEventTable,
} from "../db/schema.ts";
import { triggerRunStatusSchema } from "@platypus/schemas";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
  workspaceScopeOf,
} from "../middleware/authorization.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
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

/**
 * The detail read's one parameter: return only Run events past this sequence
 * number, for the detail page's incremental poll. Absent means the whole
 * timeline.
 */
const detailQuerySchema = z.object({
  sinceSeq: z.coerce.number().int().min(0).optional(),
});

/** Renders a validator failure as the `ValidationError` the central seam maps. */
const rejectQuery = (result: {
  success: boolean;
  error?: ReadonlyArray<{ path?: ReadonlyArray<unknown>; message: string }>;
}) => {
  if (result.success) return;
  throw new ValidationError(
    `Invalid query parameters: ${(result.error ?? [])
      .map((issue) => {
        // Name the offending parameter — "Too big" alone leaves a caller
        // guessing which of `limit` and `offset` it meant.
        const path = (issue.path ?? [])
          .map((segment) =>
            String(
              typeof segment === "object" && segment !== null
                ? (segment as { key: unknown }).key
                : segment,
            ),
          )
          .join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join("; ")}`,
  );
};

/**
 * The run as its list row reads it, joined to its Trigger for the name.
 *
 * Explicit columns, deliberately, and two are left out on purpose: the list
 * must never select a run's `finalText` (an answer per row is a page of prose
 * nobody asked for) and must never touch `trigger_run_event` — a run's
 * timeline can hold thousands of rows, and the list is polled every ten
 * seconds by every open tab. The run detail extends this projection with the
 * final text and reads the events in its own query (#647).
 */
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

/** List runs across the workspace, newest first. */
triggerRun.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  // The validator's own 400 body is not the shape this API answers with, so a
  // rejected query becomes a `ValidationError` and takes the central error seam
  // like every other 400 (ADR-0010).
  sValidator("query", listQuerySchema, rejectQuery),
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
    const { triggerId, status, limit, offset } = c.req.valid("query");

    // Joining each run to its Trigger is what scopes the listing: a run whose
    // Trigger lives in another Workspace is unreachable here regardless of the
    // `triggerId` asked for. The join also carries the Trigger's name, which
    // every row needs now the list mixes Triggers. The projection is the
    // shared one above — read its note before adding a column.
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

/**
 * One run in full: the list row's shape plus the final assistant text and
 * whether the timeline was cut short, and the run's **Run timeline** — its Run
 * events in sequence order. Pass `sinceSeq` to read only events past a
 * sequence number; the detail page polls that way at the flush interval, and
 * since an event is written open and patched when it ends, the page asks from
 * just below its oldest still-running event so the patches reach it too.
 */
triggerRun.get(
  "/:runId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  sValidator("query", detailQuerySchema, rejectQuery),
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
    const runId = c.req.param("runId");
    const { sinceSeq } = c.req.valid("query");

    // The same join scopes this read: a run id from another Workspace is a
    // run that does not exist here.
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
