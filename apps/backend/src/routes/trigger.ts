import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { triggerCreateSchema, triggerUpdateSchema } from "@platypus/schemas";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  workspaceScopeOf,
} from "../middleware/authorization.ts";
import {
  createTrigger,
  deleteTrigger,
  getTrigger,
  listTriggers,
  regenerateTriggerToken,
  toPublicTrigger,
  updateTrigger,
} from "../services/trigger.ts";
import { NotFoundError } from "../errors.ts";
import type { Variables } from "../server.ts";
import { logger } from "../logger.ts";

const trigger = new Hono<{ Variables: Variables }>();

/**
 * List the triggers in the workspace. Fired One-off Triggers are left out
 * unless `?includeFired=true`.
 */
trigger.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const results = await listTriggers(workspaceScopeOf(c), {
      includeFired: c.req.query("includeFired") === "true",
    });
    return c.json({ results: results.map(toPublicTrigger) });
  },
);

/** Get a trigger by ID */
trigger.get(
  "/:triggerId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const record = await getTrigger(
      workspaceScopeOf(c),
      c.req.param("triggerId"),
    );
    return c.json(toPublicTrigger(record));
  },
);

/** Create a new trigger */
trigger.post(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  sValidator("json", triggerCreateSchema),
  async (c) => {
    const data = c.req.valid("json");
    const scope = workspaceScopeOf(c);

    // This route is the Workspace Owner in the UI — the one surface allowed
    // to create an Inbound Trigger (ADR-0030).
    const { issuedToken, ...record } = await createTrigger(scope, data, {
      allowInbound: true,
    });

    logger.info(
      `Created trigger '${record.id}' in workspace '${scope.workspaceId}'${record.nextRunAt ? ` - next run at ${record.nextRunAt.toISOString()}` : ""}`,
    );

    // An Inbound Trigger's token is in this response and never again.
    return c.json(
      {
        ...toPublicTrigger(record),
        ...(issuedToken ? { token: issuedToken } : {}),
      },
      201,
    );
  },
);

/** Update a trigger */
trigger.put(
  "/:triggerId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  sValidator("json", triggerUpdateSchema),
  async (c) => {
    const triggerId = c.req.param("triggerId");
    const data = c.req.valid("json");

    const record = await updateTrigger(workspaceScopeOf(c), triggerId, data, {
      allowInbound: true,
    });

    logger.info(`Updated trigger '${triggerId}'`);

    return c.json(toPublicTrigger(record), 200);
  },
);

/**
 * Issue a new token for an Inbound Trigger. The old one stops working at
 * once; the new one is in this response and never again.
 */
trigger.post(
  "/:triggerId/token",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  async (c) => {
    const triggerId = c.req.param("triggerId");
    const issued = await regenerateTriggerToken(workspaceScopeOf(c), triggerId);

    logger.info(`Regenerated the token of trigger '${triggerId}'`);

    return c.json(issued, 200);
  },
);

/** Delete a trigger */
trigger.delete(
  "/:triggerId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  async (c) => {
    const triggerId = c.req.param("triggerId");

    // The Workspace Owner in the UI — the one surface allowed to delete an
    // Inbound Trigger (ADR-0030).
    if (
      !(await deleteTrigger(workspaceScopeOf(c), triggerId, {
        allowInbound: true,
      }))
    ) {
      throw new NotFoundError("Trigger not found");
    }

    logger.info(`Deleted trigger '${triggerId}'`);

    return c.json({ message: "Trigger deleted" });
  },
);

export { trigger };
