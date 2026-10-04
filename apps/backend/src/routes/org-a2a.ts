import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { orgGateAccessUpdateSchema } from "@platypus/schemas";
import { requireAuth } from "../middleware/authentication.ts";
import { orgScopeOf, requireOrgAccess } from "../middleware/authorization.ts";
import { getA2aAccess, setA2aAccess } from "../services/a2a-endpoint.ts";
import type { Variables } from "../server.ts";

/**
 * The Organization's A2A gate (ADR-0032): which Workspaces may have A2A
 * endpoints. Org Admins only, and separate from the Inbound Trigger gate.
 */
const orgA2a = new Hono<{ Variables: Variables }>();

orgA2a.get("/access", requireAuth, requireOrgAccess(["admin"]), async (c) => {
  const { orgId } = orgScopeOf(c);
  return c.json(await getA2aAccess(orgId));
});

orgA2a.put(
  "/access",
  requireAuth,
  requireOrgAccess(["admin"]),
  sValidator("json", orgGateAccessUpdateSchema),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const user = c.get("user")!;
    return c.json(await setA2aAccess(orgId, c.req.valid("json"), user.id));
  },
);

export { orgA2a };
