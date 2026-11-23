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
import { ConflictError, NotFoundError } from "../errors.ts";

const possessive = (name: string): string =>
  /s$/i.test(name) ? `${name}'` : `${name}'s`;

const defaultWorkspaceName = (name: string): string => {
  const suffix = " Workspace";
  const room = WORKSPACE_NAME_MAX_LENGTH - suffix.length;
  return `${possessive(name).slice(0, room).trimEnd()}${suffix}`;
};

export type AcceptInvitationResult =
  | { outcome: "accepted"; organizationId: string; workspaceId: string }
  | { outcome: "expired" };

export async function acceptInvitationForUser(
  invitationId: string,
  user: { id: string; name: string; email: string },
): Promise<AcceptInvitationResult> {
  return db.transaction(async (tx): Promise<AcceptInvitationResult> => {
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

    const [invite] = invitation;
    if (!invite) {
      throw new NotFoundError("Invitation not found or already processed");
    }

    // why: read the clock after the lock; the invite can expire while waiting on another writer
    if (new Date(invite.expiresAt) <= new Date()) {
      await tx
        .update(invitationTable)
        .set({ status: "expired" })
        .where(eq(invitationTable.id, invitationId));
      return { outcome: "expired" };
    }

    await tx
      .insert(organizationMember)
      .values({
        id: nanoid(),
        organizationId: invite.organizationId,
        userId: user.id,
        role: "member",
      })
      .onConflictDoNothing({
        target: [organizationMember.organizationId, organizationMember.userId],
      });
    const [member] = await tx
      .select({ id: organizationMember.id })
      .from(organizationMember)
      .where(
        and(
          eq(organizationMember.organizationId, invite.organizationId),
          eq(organizationMember.userId, user.id),
        ),
      )
      .for("share");
    if (!member) {
      throw new ConflictError(
        "Membership was removed while accepting the invitation",
      );
    }

    const workspaceId = nanoid();
    await tx.insert(workspaceTable).values({
      id: workspaceId,
      organizationId: invite.organizationId,
      ownerId: user.id,
      name: invite.workspaceName ?? defaultWorkspaceName(user.name),
    });

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
