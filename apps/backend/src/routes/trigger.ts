import { Hono } from "hono";
import { z } from "zod";
import { validate } from "../validate.ts";
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

const listQuerySchema = z.strictObject({
  includeFired: z.enum(["true", "false"]).optional(),
});

trigger.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  validate("query", listQuerySchema),
  async (c) => {
    const { includeFired } = c.req.valid("query");
    const results = await listTriggers(workspaceScopeOf(c), {
      enabledOnly: false,
      includeFired: includeFired === "true",
    });
    return c.json({ results: results.map(toPublicTrigger) });
  },
);

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

trigger.post(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  validate("json", triggerCreateSchema),
  async (c) => {
    const data = c.req.valid("json");
    const scope = workspaceScopeOf(c);

    const { issuedToken, ...record } = await createTrigger(scope, data, {
      allowInbound: true,
    });

    logger.info(
      `Created trigger '${record.id}' in workspace '${scope.workspaceId}'${record.nextRunAt ? ` - next run at ${record.nextRunAt.toISOString()}` : ""}`,
    );

    return c.json(
      {
        ...toPublicTrigger(record),
        ...(issuedToken ? { token: issuedToken } : {}),
      },
      201,
    );
  },
);

trigger.patch(
  "/:triggerId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  validate("json", triggerUpdateSchema),
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

trigger.delete(
  "/:triggerId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  async (c) => {
    const triggerId = c.req.param("triggerId");

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
