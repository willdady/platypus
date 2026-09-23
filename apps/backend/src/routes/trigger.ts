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
  updateTrigger,
} from "../services/trigger.ts";
import { NotFoundError } from "../errors.ts";
import type { Variables } from "../server.ts";
import { logger } from "../logger.ts";

const trigger = new Hono<{ Variables: Variables }>();

/** List all triggers in workspace */
trigger.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const results = await listTriggers(workspaceScopeOf(c));
    return c.json({ results });
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
    return c.json(record);
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

    const record = await createTrigger(scope, data);

    logger.info(
      `Created trigger '${record.id}' in workspace '${scope.workspaceId}'${record.nextRunAt ? ` - next run at ${record.nextRunAt.toISOString()}` : ""}`,
    );

    return c.json(record, 201);
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

    const record = await updateTrigger(workspaceScopeOf(c), triggerId, data);

    logger.info(`Updated trigger '${triggerId}'`);

    return c.json(record, 200);
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

    if (!(await deleteTrigger(workspaceScopeOf(c), triggerId))) {
      throw new NotFoundError("Trigger not found");
    }

    logger.info(`Deleted trigger '${triggerId}'`);

    return c.json({ message: "Trigger deleted" });
  },
);

export { trigger };
