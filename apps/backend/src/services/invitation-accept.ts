import { eq, and, asc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import {
  invitation as invitationTable,
  invitationBlueprint as invitationBlueprintTable,
  organizationMember,
  workspace as workspaceTable,
} from "../db/schema.ts";
import { WORKSPACE_NAME_MAX_LENGTH } from "@platypus/schemas";
import { applyBlueprintsToWorkspace } from "./blueprint-apply.ts";
import { NotFoundError } from "../errors.ts";

/**
 * Possessive form of a name for the default Workspace name (ADR-0008).
 * Names ending in "s" take a bare apostrophe ("James'"), others take "'s"
 * ("Jane's").
 */
const possessive = (name: string): string =>
  /s$/i.test(name) ? `${name}'` : `${name}'s`;

/**
 * Default Workspace name for an unnamed invite: "<member name>'s Workspace",
 * clamped to the schema's max length so the provisioned workspace stays
 * editable (a long member name could otherwise overflow the 30-char limit).
 */
const defaultWorkspaceName = (name: string): string => {
  const suffix = " Workspace";
  const room = WORKSPACE_NAME_MAX_LENGTH - suffix.length;
  return `${possessive(name).slice(0, room).trimEnd()}${suffix}`;
};

export type AcceptInvitationResult =
  | { outcome: "accepted"; organizationId: string; workspaceId: string }
  | { outcome: "expired" };

/**
 * The single accept path (#549, ADR-0019): provisions org membership, a
 * Workspace, and the invitation's Blueprints, then marks it accepted.
 *
 * Called both by the authenticated `/users/me/invitations/:id/accept` route
 * (an already-signed-in member accepting by invitation id) and by the
 * invitation-link redemption routes (a token holder, freshly registered or
 * already signed in, accepting by token) — one implementation, so a
 * link-based accept can never drift from the account-based one.
 *
 * Throws `NotFoundError` when no pending invitation matches the id and the
 * user's address, so the central `onError` answers it (ADR-0010). Expiry
 * stays a returned outcome: it has no typed error, and it writes the
 * `expired` status before reporting.
 */
export async function acceptInvitationForUser(
  invitationId: string,
  user: { id: string; name: string; email: string },
): Promise<AcceptInvitationResult> {
  return db.transaction(async (tx): Promise<AcceptInvitationResult> => {
    // Serialize acceptance with other accepts, declines, and deletion. Postgres
    // rechecks the pending predicate after a competing row lock is released.
    const invitation = await tx
      .select()
      .from(invitationTable)
      .where(
        and(
          eq(invitationTable.id, invitationId),
          eq(invitationTable.email, user.email),
          eq(invitationTable.status, "pending"),
        ),
      )
      .for("update")
      .limit(1);

    if (invitation.length === 0) {
      throw new NotFoundError("Invitation not found or already processed");
    }

    // Read the clock after acquiring the lock: an invitation can expire while
    // this transaction waits for another writer.
    if (new Date(invitation[0].expiresAt) <= new Date()) {
      await tx
        .update(invitationTable)
        .set({ status: "expired" })
        .where(eq(invitationTable.id, invitationId));
      return { outcome: "expired" };
    }

    const invite = invitation[0];

    // Ensure org membership exists
    const orgMember = await tx
      .select()
      .from(organizationMember)
      .where(
        and(
          eq(organizationMember.organizationId, invite.organizationId),
          eq(organizationMember.userId, user.id),
        ),
      )
      .limit(1);

    if (orgMember.length === 0) {
      await tx.insert(organizationMember).values({
        id: nanoid(),
        organizationId: invite.organizationId,
        userId: user.id,
        role: "member",
      });
    }

    // Accepting an invitation always provisions a Workspace owned by the
    // accepting member (ADR-0008). With no Blueprint it is empty; the invite's
    // workspaceName defaults to "<member name>'s Workspace".
    const workspaceId = nanoid();
    await tx.insert(workspaceTable).values({
      id: workspaceId,
      organizationId: invite.organizationId,
      ownerId: user.id,
      name: invite.workspaceName ?? defaultWorkspaceName(user.name),
    });

    // Apply the invitation's ordered set of Blueprints (ADR-0009) to the fresh
    // Workspace, in `position` order, so it lands pre-stamped. Tier 1
    // Attachments union; Tier 2 settings resolve last-write-wins. This shares
    // the accept transaction — a partial-list failure rolls back the whole
    // accept rather than stranding a half-stamped Workspace.
    const blueprintRows = await tx
      .select({ blueprintId: invitationBlueprintTable.blueprintId })
      .from(invitationBlueprintTable)
      .where(eq(invitationBlueprintTable.invitationId, invitationId))
      .orderBy(asc(invitationBlueprintTable.position));
    await applyBlueprintsToWorkspace(
      tx,
      workspaceId,
      blueprintRows.map((r) => r.blueprintId),
    );

    // Update invitation status
    await tx
      .update(invitationTable)
      .set({ status: "accepted" })
      .where(eq(invitationTable.id, invitationId));
    return {
      outcome: "accepted",
      organizationId: invite.organizationId,
      workspaceId,
    };
  });
}
