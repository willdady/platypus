import { Hono } from "hono";
import { validate } from "../validate.ts";
import { db } from "../index.ts";
import { agentUpdateSchema } from "@platypus/schemas";
import { requireAuth } from "../middleware/authentication.ts";
import { orgScopeOf, requireOrgAccess } from "../middleware/authorization.ts";
import {
  updateAgent as updateAgentRow,
  deleteAgent as deleteAgentRow,
  setAgentAvatar,
  clearAgentAvatar,
} from "../services/agent.ts";
import {
  listOrgScoped,
  requireOrgScoped,
} from "../services/scoped-resource.ts";
import { avatarBodyLimit } from "./avatar-body-limit.ts";
import { agentResponse } from "../services/scoped-response.ts";
import { backendBaseUrl } from "../base-urls.ts";
import type { Variables } from "../server.ts";
import { NotFoundError } from "../errors.ts";

const orgAgent = new Hono<{ Variables: Variables }>();

orgAgent.get("/", requireAuth, requireOrgAccess(), async (c) => {
  const { orgId } = orgScopeOf(c);
  const baseUrl = backendBaseUrl();
  const results = await listOrgScoped(db, "agent", orgId);
  return c.json({
    results: results.map((r) => agentResponse(r, "organization", baseUrl)),
  });
});

orgAgent.get("/:agentId", requireAuth, requireOrgAccess(), async (c) => {
  const { orgId } = orgScopeOf(c);
  const agentId = c.req.param("agentId");
  const baseUrl = backendBaseUrl();
  const record = await requireOrgScoped(db, "agent", agentId, orgId);
  return c.json(agentResponse(record, "organization", baseUrl));
});

orgAgent.put(
  "/:agentId",
  requireAuth,
  requireOrgAccess(["admin"]),
  validate("json", agentUpdateSchema),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const agentId = c.req.param("agentId");
    const data = c.req.valid("json");
    const baseUrl = backendBaseUrl();

    const result = await updateAgentRow(
      { kind: "organization", orgId },
      agentId,
      data,
    );
    if ("error" in result) {
      if (result.blockers) {
        throw new NotFoundError(
          `${result.error}: ${result.blockers
            .map((b) => `${b.name} (${b.type})`)
            .join(", ")}`,
        );
      }
      return c.json({ error: result.error }, 400);
    }
    return c.json(agentResponse(result.row, "organization", baseUrl), 200);
  },
);

orgAgent.post(
  "/:agentId/avatar",
  requireAuth,
  requireOrgAccess(["admin"]),
  avatarBodyLimit,
  async (c) => {
    const body = await c.req.parseBody();
    const row = await setAgentAvatar(
      { kind: "organization", orgId: orgScopeOf(c).orgId },
      c.req.param("agentId"),
      body["file"],
    );
    return c.json(agentResponse(row, "organization", backendBaseUrl()));
  },
);

orgAgent.delete(
  "/:agentId/avatar",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const row = await clearAgentAvatar(
      { kind: "organization", orgId: orgScopeOf(c).orgId },
      c.req.param("agentId"),
    );
    return c.json(agentResponse(row, "organization", backendBaseUrl()));
  },
);

orgAgent.delete(
  "/:agentId",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const agentId = c.req.param("agentId");

    await deleteAgentRow({ kind: "organization", orgId }, agentId);

    return c.json({ message: "Agent deleted" });
  },
);

export { orgAgent };
