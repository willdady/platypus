import { and, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import {
  a2aEndpoint as a2aEndpointTable,
  a2aToken as a2aTokenTable,
  chat as chatTable,
  mcp as mcpTable,
  mcpOauthState as mcpOauthStateTable,
  memoryDailySummary as memoryTable,
  notification as notificationTable,
  organizationMember,
  sandbox as sandboxTable,
  trigger as triggerTable,
  triggerRun as triggerRunTable,
  user as userTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
import { logger } from "../logger.ts";
import { cancelRun } from "../runs/run-cancel.ts";
import { chatStorageKeyPrefix } from "../storage/keys.ts";
import { deleteStoredPrefix } from "../storage/utils.ts";
import { errorMessage } from "../utils/error-message.ts";
import { stopRevokedA2aWork } from "./a2a-cancel.ts";
import { revokedTokenFields } from "./bearer-token.ts";
import { isBanned } from "./owner-membership.ts";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type WorkspaceTransferInput = {
  orgId: string;
  workspaceId: string;
  newOwnerId: string;
  keepHistory: boolean;
  /** The name of the Org Admin transferring it, for the new Owner's notice. */
  transferredBy: string;
};

/**
 * What a transfer leaves to do once it commits, since a rollback cannot undo
 * it: stop what was running, and delete the files of the Chats it cleared.
 */
export type TransferAftermath = {
  orgId: string;
  workspaceId: string;
  runIds: string[];
  endpointIds: string[];
  clearedChatIds: string[];
};

/**
 * Refuses a recipient who is not a member of the Organization, is banned, or
 * already owns the Workspace.
 */
const requireRecipient = async (
  tx: Tx,
  orgId: string,
  ownerId: string,
  newOwnerId: string,
) => {
  if (newOwnerId === ownerId) {
    throw new ValidationError("This member already owns the Workspace");
  }
  const [recipient] = await tx
    .select({ banned: userTable.banned, banExpires: userTable.banExpires })
    .from(organizationMember)
    .innerJoin(userTable, eq(userTable.id, organizationMember.userId))
    .where(
      and(
        eq(organizationMember.organizationId, orgId),
        eq(organizationMember.userId, newOwnerId),
      ),
    )
    .limit(1);
  if (!recipient) {
    throw new ValidationError("New Owner must be a member of the organization");
  }
  if (isBanned(recipient)) {
    throw new ValidationError("New Owner is banned");
  }
};

const noticeBody = ({ transferredBy, keepHistory }: WorkspaceTransferInput) =>
  [
    `${transferredBy} transferred this Workspace to you.`,
    keepHistory
      ? "Its Chats and Memories came with it."
      : "Its Chats, Memories and Notifications were cleared.",
    "Every Trigger is switched off, and every Inbound Trigger and A2A token was revoked: turn on and issue the ones you want.",
    "MCP servers that sign in need authorizing again.",
  ].join("\n\n");

/**
 * A Workspace transfer (ADR-0035), inside the caller's transaction. Nothing
 * that acts as the Owner carries across: Triggers go off, tokens are revoked,
 * the Owner's own credentials are cleared, and self-management is switched
 * off. Throws `ValidationError` for a recipient who may not receive it.
 * Returns what is left for {@link finishTransfer} after commit.
 */
export const applyWorkspaceTransfer = async (
  tx: Tx,
  input: WorkspaceTransferInput,
): Promise<TransferAftermath> => {
  const { orgId, workspaceId, newOwnerId, keepHistory } = input;
  const now = new Date();

  // Locked, so two transfers of one Workspace run one after the other.
  const [workspace] = await tx
    .select({ ownerId: workspaceTable.ownerId })
    .from(workspaceTable)
    .where(
      and(
        eq(workspaceTable.id, workspaceId),
        eq(workspaceTable.organizationId, orgId),
      ),
    )
    .for("update");
  if (!workspace) throw new NotFoundError("Workspace not found");
  await requireRecipient(tx, orgId, workspace.ownerId, newOwnerId);

  const triggerIds = tx
    .select({ id: triggerTable.id })
    .from(triggerTable)
    .where(eq(triggerTable.workspaceId, workspaceId));
  const mcpIds = tx
    .select({ id: mcpTable.id })
    .from(mcpTable)
    .where(eq(mcpTable.workspaceId, workspaceId));

  const runningChats = await tx
    .select({ id: chatTable.id })
    .from(chatTable)
    .where(
      and(
        eq(chatTable.workspaceId, workspaceId),
        eq(chatTable.status, "running"),
      ),
    );
  const runningRuns = await tx
    .select({ id: triggerRunTable.id })
    .from(triggerRunTable)
    .where(
      and(
        inArray(triggerRunTable.triggerId, triggerIds),
        eq(triggerRunTable.status, "running"),
      ),
    );
  const endpoints = await tx
    .select({ id: a2aEndpointTable.id })
    .from(a2aEndpointTable)
    .where(eq(a2aEndpointTable.workspaceId, workspaceId));

  await tx
    .update(workspaceTable)
    .set({
      ownerId: newOwnerId,
      providerSelfManagement: false,
      mcpSelfManagement: false,
      updatedAt: now,
    })
    .where(eq(workspaceTable.id, workspaceId));

  await tx
    .update(triggerTable)
    .set({ enabled: false, ...revokedTokenFields(), updatedAt: now })
    .where(eq(triggerTable.workspaceId, workspaceId));
  // An accepted Inbound call waits as a pending run; started after this, it
  // would run as the new Owner.
  await tx
    .update(triggerRunTable)
    .set({ status: "cancelled", completedAt: now })
    .where(
      and(
        inArray(triggerRunTable.triggerId, triggerIds),
        eq(triggerRunTable.status, "pending"),
      ),
    );
  if (endpoints.length > 0) {
    await tx.delete(a2aTokenTable).where(
      inArray(
        a2aTokenTable.endpointId,
        endpoints.map(({ id }) => id),
      ),
    );
  }

  await tx
    .update(mcpTable)
    .set({
      bearerToken: null,
      oauthAccessToken: null,
      oauthRefreshToken: null,
      oauthTokenExpiresAt: null,
      oauthScope: null,
      updatedAt: now,
    })
    .where(eq(mcpTable.workspaceId, workspaceId));
  // A sign-in the old Owner started must not finish into the new Owner's MCP.
  await tx
    .delete(mcpOauthStateTable)
    .where(inArray(mcpOauthStateTable.mcpId, mcpIds));
  await tx
    .update(sandboxTable)
    .set({ userEnv: {}, updatedAt: now })
    .where(eq(sandboxTable.workspaceId, workspaceId));

  let clearedChatIds: string[] = [];
  if (keepHistory) {
    await tx
      .update(memoryTable)
      .set({ userId: newOwnerId, updatedAt: now })
      .where(
        and(
          eq(memoryTable.workspaceId, workspaceId),
          eq(memoryTable.userId, workspace.ownerId),
        ),
      );
  } else {
    clearedChatIds = (
      await tx
        .delete(chatTable)
        .where(eq(chatTable.workspaceId, workspaceId))
        .returning({ id: chatTable.id })
    ).map(({ id }) => id);
    await tx
      .delete(triggerRunTable)
      .where(inArray(triggerRunTable.triggerId, triggerIds));
    await tx
      .delete(memoryTable)
      .where(eq(memoryTable.workspaceId, workspaceId));
    await tx
      .delete(notificationTable)
      .where(eq(notificationTable.workspaceId, workspaceId));
  }

  // Posted by Platypus, so no Agent; and no Webhook event for a transfer.
  await tx.insert(notificationTable).values({
    id: nanoid(),
    workspaceId,
    agentId: null,
    title: "This Workspace is now yours",
    body: noticeBody(input),
  });

  return {
    orgId,
    workspaceId,
    runIds: [...runningChats, ...runningRuns].map(({ id }) => id),
    endpointIds: endpoints.map(({ id }) => id),
    clearedChatIds,
  };
};

/**
 * Stops what a transfer found running: each Chat turn and Trigger run, by the
 * Chat cancel action's path, and each A2A Task, whose tokens are now gone.
 * Then deletes the cleared Chats' files. Never throws: the transfer has
 * committed.
 */
export const finishTransfer = async ({
  orgId,
  workspaceId,
  runIds,
  endpointIds,
  clearedChatIds,
}: TransferAftermath): Promise<void> => {
  await Promise.all(
    runIds.map((runId) =>
      cancelRun(runId).catch((error: unknown) =>
        logger.error(
          { runId, error: errorMessage(error) },
          "Failed to cancel a run in a transferred Workspace",
        ),
      ),
    ),
  );
  await stopRevokedA2aWork(endpointIds);
  await Promise.all(
    clearedChatIds.map((chatId) =>
      deleteStoredPrefix(chatStorageKeyPrefix({ orgId, workspaceId, chatId })),
    ),
  );
};

/** A Workspace transfer in its own transaction, then finished. */
export const transferWorkspace = async (
  input: WorkspaceTransferInput,
): Promise<void> => {
  await finishTransfer(
    await db.transaction((tx) => applyWorkspaceTransfer(tx, input)),
  );
};
