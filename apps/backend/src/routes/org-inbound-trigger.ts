import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { orgGateAccessUpdateSchema } from "@platypus/schemas";
import { requireAuth } from "../middleware/authentication.ts";
import { orgScopeOf, requireOrgAccess } from "../middleware/authorization.ts";
import {
  getInboundTriggerAccess,
  listOrgInboundTriggers,
  revokeInboundTriggerToken,
  setInboundTriggerAccess,
} from "../services/inbound-trigger.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
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

/** The Organization gate and every Workspace's switch. */
orgInboundTrigger.get(
  "/access",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    return c.json(await getInboundTriggerAccess(orgId));
  },
);

/**
 * Set the gate and, with `allowedWorkspaceIds`, every Workspace's switch in
 * the same write. Answers with the access as it now stands.
 */
orgInboundTrigger.put(
  "/access",
  requireAuth,
  requireOrgAccess(["admin"]),
  sValidator("json", orgGateAccessUpdateSchema),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const user = c.get("user")!;
    return c.json(
      await setInboundTriggerAccess(orgId, c.req.valid("json"), user.id),
    );
  },
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
    const seenTokenCreatedAt = new Date(c.req.query("tokenCreatedAt") ?? "");
    if (Number.isNaN(seenTokenCreatedAt.getTime())) {
      throw new ValidationError(
        "tokenCreatedAt must name the token to revoke, as the list reported it.",
      );
    }
    const found = await revokeInboundTriggerToken(
      orgId,
      c.req.param("triggerId"),
      seenTokenCreatedAt,
    );
    if (!found) {
      throw new NotFoundError("Inbound trigger not found");
    }
    return c.json({ message: "Token revoked" });
  },
);

export { orgInboundTrigger };
