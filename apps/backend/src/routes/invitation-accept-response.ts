import type { Context } from "hono";
import type { AcceptInvitationResult } from "../services/invitation-accept.ts";

export function acceptResultResponse(
  c: Context,
  result: AcceptInvitationResult,
) {
  if (result.outcome === "expired") {
    return c.json({ error: "Invitation has expired" }, 410);
  }

  return c.json({
    message: "Invitation accepted",
    organizationId: result.organizationId,
    workspaceId: result.workspaceId,
  });
}
