import { Hono } from "hono";
import { requireAuth } from "../middleware/authentication.ts";
import { orgScopeOf, requireOrgAccess } from "../middleware/authorization.ts";
import {
  getInboundTriggerAccess,
  listOrgInboundTriggers,
  revokeInboundTriggerToken,
  setInboundTriggerAccess,
} from "../services/inbound-trigger.ts";
import { NotFoundError } from "../errors.ts";
import {
  mountGateAccess,
  seenTokenCreatedAt,
  tokenCreatedAtQuerySchema,
} from "./org-gate-access.ts";
import { validate } from "../validate.ts";
import type { Variables } from "../server.ts";

const orgInboundTrigger = new Hono<{ Variables: Variables }>();

orgInboundTrigger.get(
  "/",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    return c.json({ results: await listOrgInboundTriggers(orgId) });
  },
);

mountGateAccess(
  orgInboundTrigger,
  getInboundTriggerAccess,
  setInboundTriggerAccess,
);

orgInboundTrigger.delete(
  "/:triggerId/token",
  requireAuth,
  requireOrgAccess(["admin"]),
  validate("query", tokenCreatedAtQuerySchema),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const found = await revokeInboundTriggerToken(
      orgId,
      c.req.param("triggerId"),
      seenTokenCreatedAt(c.req.valid("query")),
    );
    if (!found) {
      throw new NotFoundError("Inbound trigger not found");
    }
    return c.json({ message: "Token revoked" });
  },
);

export { orgInboundTrigger };
