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
import { mountGateAccess, seenTokenCreatedAt } from "./org-gate-access.ts";
import type { Variables } from "../server.ts";

/**
 * Org Admin oversight of Inbound Triggers (ADR-0030): see every one in the
 * Organization and revoke a token, and decide which Workspaces take calls
 * at all. Nothing else — no edit, no disable, no lock. The Workspace Owner
 * creates, edits and regenerates; the Organization gate is the broader off
 * switch.
 */
const orgInboundTrigger = new Hono<{ Variables: Variables }>();

/** Every Inbound Trigger in the Organization. Never a token. */
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

/**
 * Revoke an Inbound Trigger's token. The Owner is notified. `tokenCreatedAt`
 * names the token the Admin saw, as the list reported it; `409` when the
 * current one was issued at another time.
 */
orgInboundTrigger.delete(
  "/:triggerId/token",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const found = await revokeInboundTriggerToken(
      orgId,
      c.req.param("triggerId"),
      seenTokenCreatedAt(c),
    );
    if (!found) {
      throw new NotFoundError("Inbound trigger not found");
    }
    return c.json({ message: "Token revoked" });
  },
);

export { orgInboundTrigger };
