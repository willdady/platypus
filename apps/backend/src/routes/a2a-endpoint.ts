import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import {
  a2aEndpointCreateSchema,
  a2aEndpointUpdateSchema,
  a2aTokenCreateSchema,
} from "@platypus/schemas";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  workspaceScopeOf,
} from "../middleware/authorization.ts";
import {
  createA2aEndpoint,
  createA2aToken,
  deleteA2aEndpoint,
  deleteA2aToken,
  getA2aEndpoint,
  listA2aEndpoints,
  updateA2aEndpoint,
} from "../services/a2a-endpoint.ts";
import type { Variables } from "../server.ts";

/**
 * A Workspace's A2A endpoints and their tokens (ADR-0032). Org Admins read;
 * only the Owner writes, and only here — no Agent tool reaches endpoints or
 * tokens.
 */
const a2aEndpoint = new Hono<{ Variables: Variables }>();

const readers = [
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
] as const;
const owner = [...readers, requireWorkspaceOwner] as const;

a2aEndpoint.get("/", ...readers, async (c) => {
  const { workspaceId } = workspaceScopeOf(c);
  return c.json({ results: await listA2aEndpoints(workspaceId) });
});

a2aEndpoint.get("/:endpointId", ...readers, async (c) => {
  const { workspaceId } = workspaceScopeOf(c);
  return c.json(await getA2aEndpoint(workspaceId, c.req.param("endpointId")));
});

a2aEndpoint.post(
  "/",
  ...owner,
  sValidator("json", a2aEndpointCreateSchema),
  async (c) => {
    const scope = workspaceScopeOf(c);
    return c.json(await createA2aEndpoint(scope, c.req.valid("json")), 201);
  },
);

a2aEndpoint.put(
  "/:endpointId",
  ...owner,
  sValidator("json", a2aEndpointUpdateSchema),
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
    return c.json(
      await updateA2aEndpoint(
        workspaceId,
        c.req.param("endpointId"),
        c.req.valid("json"),
      ),
    );
  },
);

a2aEndpoint.delete("/:endpointId", ...owner, async (c) => {
  const { workspaceId } = workspaceScopeOf(c);
  await deleteA2aEndpoint(workspaceId, c.req.param("endpointId"));
  return c.json({ message: "A2A endpoint deleted" });
});

/** The token's value is in this response and never again. */
a2aEndpoint.post(
  "/:endpointId/tokens",
  ...owner,
  sValidator("json", a2aTokenCreateSchema),
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
    return c.json(
      await createA2aToken(
        workspaceId,
        c.req.param("endpointId"),
        c.req.valid("json").name,
      ),
      201,
    );
  },
);

a2aEndpoint.delete("/:endpointId/tokens/:tokenId", ...owner, async (c) => {
  const { workspaceId } = workspaceScopeOf(c);
  await deleteA2aToken(
    workspaceId,
    c.req.param("endpointId"),
    c.req.param("tokenId"),
  );
  return c.json({ message: "A2A token deleted" });
});

export { a2aEndpoint };
