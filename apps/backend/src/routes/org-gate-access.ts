import type { Hono } from "hono";
import { z } from "zod";
import { validate } from "../validate.ts";
import {
  orgGateAccessUpdateSchema,
  type OrgGateAccessUpdate,
} from "@platypus/schemas";
import { requireAuth } from "../middleware/authentication.ts";
import {
  orgScopeOf,
  requireOrgAccess,
  userOf,
} from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";

export const mountGateAccess = <T>(
  app: Hono<{ Variables: Variables }>,
  get: (orgId: string) => Promise<T>,
  set: (
    orgId: string,
    update: OrgGateAccessUpdate,
    actorUserId: string,
  ) => Promise<T>,
): void => {
  app.get("/access", requireAuth, requireOrgAccess(["admin"]), async (c) => {
    const { orgId } = orgScopeOf(c);
    return c.json(await get(orgId));
  });
  app.put(
    "/access",
    requireAuth,
    requireOrgAccess(["admin"]),
    validate("json", orgGateAccessUpdateSchema),
    async (c) => {
      const { orgId } = orgScopeOf(c);
      const user = userOf(c);
      return c.json(await set(orgId, c.req.valid("json"), user.id));
    },
  );
};

export const tokenCreatedAtQuerySchema = z.strictObject({
  tokenCreatedAt: z.iso.datetime(),
});

export const seenTokenCreatedAt = (query: { tokenCreatedAt: string }): Date =>
  new Date(query.tokenCreatedAt);
