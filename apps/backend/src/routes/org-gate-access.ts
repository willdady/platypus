import type { Context, Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import {
  orgGateAccessUpdateSchema,
  type OrgGateAccessUpdate,
} from "@platypus/schemas";
import { requireAuth } from "../middleware/authentication.ts";
import { orgScopeOf, requireOrgAccess } from "../middleware/authorization.ts";
import { ValidationError } from "../errors.ts";
import type { Variables } from "../server.ts";

/**
 * Org Admin oversight shared by the ways in from outside that carry a bearer
 * token — Inbound Triggers (ADR-0030) and A2A endpoints (ADR-0032).
 */

/**
 * `GET /access` reads the Organization gate and every Workspace's switch;
 * `PUT /access` sets the gate and, with `allowedWorkspaceIds`, every switch in
 * the same write, answering with the access as it now stands.
 */
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
    sValidator("json", orgGateAccessUpdateSchema),
    async (c) => {
      const { orgId } = orgScopeOf(c);
      const user = c.get("user")!;
      return c.json(await set(orgId, c.req.valid("json"), user.id));
    },
  );
};

/**
 * The `tokenCreatedAt` an Org Admin's revoke names: when the token they saw
 * was issued, as the list reported it, so one issued since is refused.
 */
export const seenTokenCreatedAt = (c: Context): Date => {
  const seen = new Date(c.req.query("tokenCreatedAt") ?? "");
  if (Number.isNaN(seen.getTime())) {
    throw new ValidationError(
      "tokenCreatedAt must name the token to revoke, as the list reported it.",
    );
  }
  return seen;
};
