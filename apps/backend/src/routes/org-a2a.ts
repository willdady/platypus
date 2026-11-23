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
import {
  mountGateAccess,
  seenTokenCreatedAt,
  tokenCreatedAtQuerySchema,
} from "./org-gate-access.ts";
import { validate } from "../validate.ts";
import type { Variables } from "../server.ts";

const orgA2a = new Hono<{ Variables: Variables }>();

mountGateAccess(orgA2a, getA2aAccess, setA2aAccess);

orgA2a.get(
  "/endpoints",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    return c.json({ results: await listOrgA2aEndpoints(orgId) });
  },
);

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

orgA2a.delete(
  "/endpoints/:endpointId/tokens/:tokenId",
  requireAuth,
  requireOrgAccess(["admin"]),
  validate("query", tokenCreatedAtQuerySchema),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const found = await revokeOrgA2aToken(
      orgId,
      c.req.param("endpointId"),
      c.req.param("tokenId"),
      seenTokenCreatedAt(c.req.valid("query")),
    );
    if (!found) throw new NotFoundError("A2A token not found");
    return c.json({ message: "A2A token revoked" });
  },
);

export { orgA2a };
