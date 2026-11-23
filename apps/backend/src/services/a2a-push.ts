import { randomUUID } from "node:crypto";
import { and, asc, count, eq, isNull, or, sql } from "drizzle-orm";
import {
  A2A_CONTENT_TYPE,
  StreamResponse,
  type Task,
  type TaskPushNotificationConfig,
} from "@a2a-js/sdk";
import { RequestMalformedError, TaskNotFoundError } from "@a2a-js/sdk/errors";
import { db } from "../index.ts";
import {
  a2aPushConfig as a2aPushConfigTable,
  a2aTask as a2aTaskTable,
  type A2aPushAuthentication,
} from "../db/schema.ts";
import { logger } from "../logger.ts";
import type { A2aCaller } from "./a2a-task.ts";
import {
  findA2aTask,
  readRecordedTask,
  taskHasEnded,
  type TaskRow,
} from "./a2a-task-state.ts";
import { postWithRetries } from "./webhook-delivery.ts";
import { taskIsLive } from "./a2a-liveness.ts";
import { env } from "../env.ts";
import { oneRow } from "../db/one-row.ts";

type PushConfigRow = typeof a2aPushConfigTable.$inferSelect;

const configKey = (taskId: string, id: string) =>
  and(eq(a2aPushConfigTable.taskId, taskId), eq(a2aPushConfigTable.id, id));

const pending = (taskId: string) =>
  and(
    eq(a2aPushConfigTable.taskId, taskId),
    isNull(a2aPushConfigTable.notifiedAt),
  );

const credentialHeaders = (config: PushConfigRow): Record<string, string> => ({
  ...(config.authentication?.credentials
    ? {
        Authorization: `${config.authentication.scheme} ${config.authentication.credentials}`,
      }
    : {}),
  ...(config.token ? { "X-A2A-Notification-Token": config.token } : {}),
});

const privateNetworksAllowed = () => env().A2A_PUSH_ALLOW_PRIVATE_NETWORKS;

export const MAX_CONCURRENT_PUSHES = 8;
let pushesInFlight = 0;
const waitingForSlot: (() => void)[] = [];

const withPushSlot = async (send: () => Promise<void>): Promise<void> => {
  if (pushesInFlight < MAX_CONCURRENT_PUSHES) pushesInFlight++;
  else await new Promise<void>((resolve) => waitingForSlot.push(resolve));
  try {
    await send();
  } finally {
    const next = waitingForSlot.shift();
    if (next) next();
    else pushesInFlight--;
  }
};

const deliver = (config: PushConfigRow, task: Task) =>
  withPushSlot(() =>
    postWithRetries({
      url: config.url,
      body: JSON.stringify(
        StreamResponse.toJSON({ payload: { $case: "task", value: task } }),
      ),
      headers: {
        "Content-Type": A2A_CONTENT_TYPE,
        ...credentialHeaders(config),
      },
      label: "A2A push notification",
      allowPrivateNetworks: privateNetworksAllowed(),
    }),
  );

const MAX_PUSHES_PER_TASK = 5;

const reservePushes = async (
  taskId: string,
  wanted: number,
): Promise<number> => {
  // why: each lost compare-and-set means another caller took a push, so this bound ends
  for (let attempt = 0; attempt <= MAX_PUSHES_PER_TASK; attempt++) {
    const [task] = await db
      .select({ pushCount: a2aTaskTable.pushCount })
      .from(a2aTaskTable)
      .where(eq(a2aTaskTable.id, taskId))
      .limit(1);
    if (!task) return 0;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- NOT NULL in Postgres, but the tests' in-memory db skips column defaults
    const sent = task.pushCount ?? 0;
    const granted = Math.min(wanted, MAX_PUSHES_PER_TASK - sent);
    if (granted <= 0) return 0;
    const reserved = await db
      .update(a2aTaskTable)
      .set({ pushCount: sent + granted })
      .where(
        and(
          eq(a2aTaskTable.id, taskId),
          eq(a2aTaskTable.pushCount, task.pushCount),
        ),
      )
      .returning({ id: a2aTaskTable.id });
    if (reserved.length > 0) return granted;
  }
  return 0;
};

const taskRowNow = async (taskId: string): Promise<TaskRow | undefined> => {
  const [row] = await db
    .select()
    .from(a2aTaskTable)
    .where(eq(a2aTaskTable.id, taskId))
    .limit(1);
  return row;
};

export const pushRecordedEnd = async (row: TaskRow): Promise<void> => {
  try {
    const recorded = row.state ? row : await taskRowNow(row.id);
    if (!recorded?.state) return;
    const task = await readRecordedTask({ ...recorded, state: recorded.state });
    const claimed = await db
      .update(a2aPushConfigTable)
      .set({ notifiedAt: new Date() })
      .where(pending(row.id))
      .returning();
    if (claimed.length === 0) return;
    const current = await taskRowNow(row.id);
    if (!current || !(await taskIsLive(current))) {
      logger.info(
        { taskId: row.id, dropped: claimed.length },
        "A2A Task's access was cut off; dropping its push notifications",
      );
      return;
    }
    claimed.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const granted = await reservePushes(row.id, claimed.length);
    if (granted < claimed.length) {
      logger.warn(
        { taskId: row.id, dropped: claimed.length - granted },
        "A2A Task has sent all its push notifications; dropping the rest",
      );
    }
    await Promise.all(
      claimed.slice(0, granted).map((config) => deliver(config, task)),
    );
  } catch (error) {
    logger.error({ error, taskId: row.id }, "A2A push notification failed");
  }
};

const MAX_PUSH_CONFIGS_PER_TASK = 5;

const AUTH_SCHEME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const hasControlChar = (value: string) =>
  [...value].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);

type CheckedPushConfig = {
  id: string;
  url: string;
  token: string | null;
  authentication: A2aPushAuthentication | null;
};

const isHttpUrl = (value: string) => {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") && !!url.hostname
    );
  } catch {
    return false;
  }
};

export const checkPushConfig = (
  config: TaskPushNotificationConfig,
): CheckedPushConfig => {
  if (!config.url || !isHttpUrl(config.url)) {
    throw new RequestMalformedError(
      "A push notification config needs an http or https url",
    );
  }
  const auth = config.authentication;
  if (auth?.credentials && !auth.scheme) {
    throw new RequestMalformedError(
      "Push notification credentials need a scheme",
    );
  }
  if (
    (auth?.scheme && !AUTH_SCHEME.test(auth.scheme)) ||
    (auth?.credentials && hasControlChar(auth.credentials)) ||
    hasControlChar(config.token)
  ) {
    throw new RequestMalformedError(
      "Push notification credentials must be valid HTTP header values",
    );
  }
  return {
    id: config.id,
    url: config.url,
    token: config.token || null,
    authentication: auth?.scheme
      ? {
          scheme: auth.scheme,
          ...(auth.credentials ? { credentials: auth.credentials } : {}),
        }
      : null,
  };
};

export const storePushConfig = async (
  task: TaskRow,
  config: CheckedPushConfig,
): Promise<PushConfigRow> => {
  const values = {
    url: config.url,
    token: config.token,
    authentication: config.authentication,
  };
  const ended = await taskHasEnded(task);
  const urlLocked = () =>
    new RequestMalformedError(
      "A push notification config's url can't change once its Task has ended",
    );
  const row = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(a2aPushConfigTable)
      .where(
        config.id
          ? configKey(task.id, config.id)
          : and(
              eq(a2aPushConfigTable.taskId, task.id),
              eq(a2aPushConfigTable.url, config.url),
            ),
      )
      .limit(1);
    if (existing) {
      if (existing.url !== config.url && (ended || existing.notifiedAt)) {
        throw urlLocked();
      }
      const [updated] = await tx
        .update(a2aPushConfigTable)
        .set(values)
        .where(configKey(task.id, existing.id))
        .returning();
      if (!updated) {
        throw new TaskNotFoundError("Push notification config not found");
      }
      return updated;
    }

    const { n } = oneRow(
      await tx
        .select({ n: count() })
        .from(a2aPushConfigTable)
        .where(eq(a2aPushConfigTable.taskId, task.id)),
    );
    if (n >= MAX_PUSH_CONFIGS_PER_TASK) {
      throw new RequestMalformedError(
        `A Task takes at most ${MAX_PUSH_CONFIGS_PER_TASK} push notification configs`,
      );
    }
    const [inserted] = await tx
      .insert(a2aPushConfigTable)
      .values({ id: config.id || randomUUID(), taskId: task.id, ...values })
      .onConflictDoUpdate({
        target: [a2aPushConfigTable.taskId, a2aPushConfigTable.id],
        set: values,
        setWhere: or(
          isNull(a2aPushConfigTable.notifiedAt),
          sql`${a2aPushConfigTable.url} = excluded.url`,
        ),
      })
      .returning();
    if (!inserted) throw urlLocked();
    return inserted;
  });
  if (!row.notifiedAt) void pushRecordedEnd(task);
  return row;
};

const toWire = (row: PushConfigRow): TaskPushNotificationConfig => ({
  tenant: "",
  id: row.id,
  taskId: row.taskId,
  url: row.url,
  token: "",
  authentication: row.authentication
    ? { scheme: row.authentication.scheme, credentials: "" }
    : undefined,
});

const requireConfigId = (id: string) => {
  if (!id) {
    throw new RequestMalformedError(
      "A push notification config id is required",
    );
  }
};

export const createA2aPushConfig = async (
  caller: A2aCaller,
  params: TaskPushNotificationConfig,
): Promise<TaskPushNotificationConfig> => {
  const task = await findA2aTask(caller, params.taskId);
  return toWire(await storePushConfig(task, checkPushConfig(params)));
};

export const getA2aPushConfig = async (
  caller: A2aCaller,
  params: { taskId: string; id: string },
): Promise<TaskPushNotificationConfig> => {
  const task = await findA2aTask(caller, params.taskId);
  requireConfigId(params.id);
  const [row] = await db
    .select()
    .from(a2aPushConfigTable)
    .where(configKey(task.id, params.id))
    .limit(1);
  // why: A2A has no missing-config error; the SDK's own handler answers this one too
  if (!row) throw new TaskNotFoundError("Push notification config not found");
  return toWire(row);
};

export const listA2aPushConfigs = async (
  caller: A2aCaller,
  params: { taskId: string },
) => {
  const task = await findA2aTask(caller, params.taskId);
  const rows = await db
    .select()
    .from(a2aPushConfigTable)
    .where(eq(a2aPushConfigTable.taskId, task.id))
    .orderBy(asc(a2aPushConfigTable.createdAt));
  return { configs: rows.map(toWire), nextPageToken: "" };
};

export const deleteA2aPushConfig = async (
  caller: A2aCaller,
  params: { taskId: string; id: string },
): Promise<void> => {
  const task = await findA2aTask(caller, params.taskId);
  requireConfigId(params.id);
  await db.delete(a2aPushConfigTable).where(configKey(task.id, params.id));
};
