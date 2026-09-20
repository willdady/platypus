import type { Context } from "hono";
import type { AcceptInvitationResult } from "../services/invitation-accept.ts";

/**
 * The HTTP response for an accept outcome, stated once for every route that
 * accepts an invitation. A successful accept reports the Organization and the
 * freshly provisioned Workspace, so a caller can land the new member there
 * rather than guessing where they belong.
 *
 * A missing or already-processed invitation is not here: the service throws
 * `NotFoundError` for it and the central `onError` maps it (ADR-0010).
 */
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
