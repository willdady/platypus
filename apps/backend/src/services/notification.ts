import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import {
  agent as agentTable,
  notification as notificationTable,
  notificationRead as notificationReadTable,
} from "../db/schema.ts";
import { ownedWhere, resolveOwned } from "./workspace-resource.ts";
import { dispatchEvent } from "./event-dispatch.ts";
import { currentRunSource, type RunSource } from "../event-causation.ts";

type Database = typeof db;
type NotificationContext = {
  orgId: string;
  workspaceId: string;
  agentId?: string;
};

const normalizeBody = (body: string) =>
  body.replace(/\\n/g, "\n").replace(/\\t/g, "\t");

type NotificationRow = typeof notificationTable.$inferSelect;

/** The source a stored row names, from whichever column is set. */
export const notificationSource = (row: {
  sourceChatId?: string | null;
  sourceTriggerRunId?: string | null;
}): RunSource | null =>
  row.sourceChatId
    ? { kind: "chat", chatId: row.sourceChatId }
    : row.sourceTriggerRunId
      ? { kind: "triggerRun", triggerRunId: row.sourceTriggerRunId }
      : null;

/** A row as the API and Webhooks carry it: the source columns as `source`. */
const toRecord = ({
  sourceChatId,
  sourceTriggerRunId,
  ...rest
}: NotificationRow) => ({
  ...rest,
  source: notificationSource({ sourceChatId, sourceTriggerRunId }),
});

const agentOwnedWhere = (ctx: NotificationContext, id: string) =>
  and(
    ownedWhere("notification", { id, workspaceId: ctx.workspaceId }),
    ctx.agentId ? eq(notificationTable.agentId, ctx.agentId) : undefined,
  );

export const createNotification = async (
  database: Database,
  ctx: Required<NotificationContext>,
  data: { title?: string; body: string },
) => {
  // Read from the run, never the caller: an Agent cannot set or spoof it.
  const source = currentRunSource();
  const rows = await database
    .insert(notificationTable)
    .values({
      id: nanoid(),
      workspaceId: ctx.workspaceId,
      agentId: ctx.agentId,
      title: data.title ?? null,
      body: normalizeBody(data.body),
      sourceChatId: source?.kind === "chat" ? source.chatId : null,
      sourceTriggerRunId:
        source?.kind === "triggerRun" ? source.triggerRunId : null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();
  const record = toRecord(rows[0]);
  dispatchEvent(ctx.orgId, ctx.workspaceId, {
    event: "notification.created",
    // Written with the Agent's id, so it has one; only Platypus posts without.
    data: { ...record, agentId: ctx.agentId },
  });
  return record;
};

export const listNotifications = async (
  database: Database,
  ctx: Required<NotificationContext>,
  limit: number,
) =>
  (
    await database
      .select()
      .from(notificationTable)
      .where(
        and(
          eq(notificationTable.workspaceId, ctx.workspaceId),
          eq(notificationTable.agentId, ctx.agentId),
        ),
      )
      .orderBy(desc(notificationTable.createdAt))
      .limit(limit)
  ).map(toRecord);

export const updateNotification = async (
  database: Database,
  ctx: Required<NotificationContext>,
  id: string,
  data: { title?: string; body?: string },
) => {
  const rows = await database
    .update(notificationTable)
    .set({
      ...(data.title !== undefined && { title: data.title }),
      ...(data.body !== undefined && {
        body: normalizeBody(data.body),
      }),
      updatedAt: new Date(),
    })
    .where(agentOwnedWhere(ctx, id))
    .returning();
  if (!rows.length) return null;
  const record = toRecord(rows[0]);
  dispatchEvent(ctx.orgId, ctx.workspaceId, {
    event: "notification.updated",
    // Matched on the Agent's id, so it has one.
    data: { ...record, agentId: ctx.agentId },
  });
  return record;
};

export const deleteNotification = async (
  database: Database,
  ctx: NotificationContext,
  id: string,
) => {
  if (ctx.agentId) {
    const existing = await database
      .select({ id: notificationTable.id })
      .from(notificationTable)
      .where(agentOwnedWhere(ctx, id))
      .limit(1);
    if (!existing.length) return false;
  }
  const rows = await database
    .delete(notificationTable)
    .where(agentOwnedWhere(ctx, id))
    .returning();
  if (Array.isArray(rows) && rows.length === 0) return false;
  dispatchEvent(ctx.orgId, ctx.workspaceId, {
    event: "notification.dismissed",
    data: { notificationId: id },
  });
  return true;
};

export const markRead = async (
  database: Database,
  ctx: { orgId: string; workspaceId: string },
  notificationId: string,
  userId: string,
) => {
  const owned = await resolveOwned(database, "notification", {
    id: notificationId,
    workspaceId: ctx.workspaceId,
  });
  if (!owned) return false;
  await database
    .insert(notificationReadTable)
    .values({ id: nanoid(), notificationId, userId })
    .onConflictDoNothing();
  dispatchEvent(ctx.orgId, ctx.workspaceId, {
    event: "notification.read",
    data: { notificationId, userId },
  });
  return true;
};

export const markAllRead = async (
  database: Database,
  ctx: { orgId: string; workspaceId: string },
  notificationIds: string[],
  userId: string,
) => {
  const owned =
    notificationIds.length === 0
      ? []
      : await database
          .select({ id: notificationTable.id })
          .from(notificationTable)
          .where(
            and(
              eq(notificationTable.workspaceId, ctx.workspaceId),
              inArray(notificationTable.id, notificationIds),
            ),
          );
  if (owned.length === 0) return;
  const ids = owned.map(({ id }) => id);
  await database.insert(notificationReadTable).values(
    ids.map((notificationId) => ({
      id: nanoid(),
      notificationId,
      userId,
    })),
  );
  dispatchEvent(ctx.orgId, ctx.workspaceId, {
    event: "notification.read",
    data: { notificationIds: ids, userId, bulk: true },
  });
};

export const listWorkspaceNotifications = (
  database: Database,
  workspaceId: string,
  userId: string,
  limit: number,
  offset: number,
) =>
  database
    .select({
      id: notificationTable.id,
      workspaceId: notificationTable.workspaceId,
      agentId: notificationTable.agentId,
      title: notificationTable.title,
      body: notificationTable.body,
      sourceChatId: notificationTable.sourceChatId,
      sourceTriggerRunId: notificationTable.sourceTriggerRunId,
      createdAt: notificationTable.createdAt,
      updatedAt: notificationTable.updatedAt,
      agentName: agentTable.name,
      agentAvatarKey: agentTable.avatarKey,
      readAt: notificationReadTable.readAt,
    })
    .from(notificationTable)
    .leftJoin(agentTable, eq(notificationTable.agentId, agentTable.id))
    .leftJoin(
      notificationReadTable,
      and(
        eq(notificationReadTable.notificationId, notificationTable.id),
        eq(notificationReadTable.userId, userId),
      ),
    )
    .where(eq(notificationTable.workspaceId, workspaceId))
    .orderBy(desc(notificationTable.createdAt))
    .limit(limit)
    .offset(offset);

export const unreadNotificationCount = (
  database: Database,
  workspaceId: string,
  userId: string,
) =>
  database
    .select({ count: sql<number>`count(*)::int` })
    .from(notificationTable)
    .leftJoin(
      notificationReadTable,
      and(
        eq(notificationReadTable.notificationId, notificationTable.id),
        eq(notificationReadTable.userId, userId),
      ),
    )
    .where(
      and(
        eq(notificationTable.workspaceId, workspaceId),
        isNull(notificationReadTable.id),
      ),
    );

export const unreadNotificationIds = (
  database: Database,
  workspaceId: string,
  userId: string,
) =>
  database
    .select({ id: notificationTable.id })
    .from(notificationTable)
    .leftJoin(
      notificationReadTable,
      and(
        eq(notificationReadTable.notificationId, notificationTable.id),
        eq(notificationReadTable.userId, userId),
      ),
    )
    .where(
      and(
        eq(notificationTable.workspaceId, workspaceId),
        isNull(notificationReadTable.id),
      ),
    );
