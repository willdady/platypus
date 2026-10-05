import { Hono } from "hono";
import { requireAuth } from "../middleware/authentication.ts";
import { orgScopeOf, requireOrgAccess } from "../middleware/authorization.ts";
import {
  getA2aAccess,
  listOrgA2aEndpoints,
  revokeOrgA2aEndpoint,
  revokeOrgA2aToken,
  setA2aAccess,
} from "../services/a2a-endpoint.ts";
import { NotFoundError } from "../errors.ts";
import { mountGateAccess, seenTokenCreatedAt } from "./org-gate-access.ts";
import type { Variables } from "../server.ts";

/**
 * Org Admin oversight of A2A (ADR-0032): the gate deciding which Workspaces
 * may have endpoints, separate from the Inbound Trigger gate, and every
 * endpoint and token in the Organization, each of which an Admin can revoke.
 * Nothing else — no create or edit; the Workspace Owner does that.
 */
const orgA2a = new Hono<{ Variables: Variables }>();

mountGateAccess(orgA2a, getA2aAccess, setA2aAccess);

/** Every endpoint in the Organization with its tokens. Never a token. */
orgA2a.get(
  "/endpoints",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    return c.json({ results: await listOrgA2aEndpoints(orgId) });
  },
);

/** Revoke an endpoint, deleting it with its tokens. The Owner is notified. */
orgA2a.delete(
  "/endpoints/:endpointId",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    if (!(await revokeOrgA2aEndpoint(orgId, c.req.param("endpointId")))) {
      throw new NotFoundError("A2A endpoint not found");
    }
    return c.json({ message: "A2A endpoint revoked" });
  },
);

/**
 * Revoke one token on an endpoint. The Owner is notified. `tokenCreatedAt`
 * names the value the Admin saw, as the list reported it; `409` when the
 * token was regenerated since.
 */
orgA2a.delete(
  "/endpoints/:endpointId/tokens/:tokenId",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const found = await revokeOrgA2aToken(
      orgId,
      c.req.param("endpointId"),
      c.req.param("tokenId"),
      seenTokenCreatedAt(c),
    );
    if (!found) throw new NotFoundError("A2A token not found");
    return c.json({ message: "A2A token revoked" });
  },
);

export { orgA2a };
