import { and, eq } from "drizzle-orm";
import { organizationMember, workspace } from "../db/schema.ts";

/**
 * The join condition for the Workspace Owner's membership of the Workspace's
 * Organization. Left-joined, a null membership means the Owner has left, and
 * nothing may act as them: no Trigger fires and no A2A endpoint answers
 * (GHSA-h9jr-rxwg-pgx3). The one place that rule is written.
 */
export const ownerMembershipJoin = () =>
  and(
    eq(organizationMember.organizationId, workspace.organizationId),
    eq(organizationMember.userId, workspace.ownerId),
  );
