import { randomUUID } from "node:crypto";
import { and, asc, count, eq, isNull } from "drizzle-orm";
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
import { checkEgress } from "../utils/egress-guard.ts";
import {
  readTask,
  TERMINAL_TASK_STATES,
  type TaskRow,
} from "./a2a-task-state.ts";
import { postWithRetries } from "./webhook-delivery.ts";

/**
 * A2A push notifications (ADR-0032): when a Task ends — `completed`, `failed`
 * or `canceled` — it is POSTed to every URL its client registered, with the
 * credentials the client supplied, over the Webhook transport (its egress
 * guard and retries). Nothing is pushed for an intermediate state.
 *
 * Each config is delivered once. Its `notifiedAt` is claimed before sending,
 * so the run's end and a registration landing just after it can't both push.
 *
 * ponytail: at most once. A process that dies between the claim and a landed
 * delivery loses that push; the client can still poll `GetTask`. Claim after
 * delivering, with a lease, if clients need it guaranteed.
 */

type PushConfigRow = typeof a2aPushConfigTable.$inferSelect;

/** One config of one Task. */
const configKey = (taskId: string, id: string) =>
  and(eq(a2aPushConfigTable.taskId, taskId), eq(a2aPushConfigTable.id, id));

/** A Task's configs not yet delivered. */
const pending = (taskId: string) =>
  and(
    eq(a2aPushConfigTable.taskId, taskId),
    isNull(a2aPushConfigTable.notifiedAt),
  );

/** The headers carrying the client's own credentials back to it. */
const credentialHeaders = (config: PushConfigRow): Record<string, string> => ({
  ...(config.authentication
    ? {
        Authorization: `${config.authentication.scheme} ${config.authentication.credentials}`,
      }
    : {}),
  ...(config.token ? { "X-A2A-Notification-Token": config.token } : {}),
});

const deliver = async (config: PushConfigRow, task: Task) => {
  const body = JSON.stringify(
    StreamResponse.toJSON({ payload: { $case: "task", value: task } }),
  );
  await postWithRetries({
    url: config.url,
    body,
    headers: { "Content-Type": A2A_CONTENT_TYPE, ...credentialHeaders(config) },
    label: "A2A push notification",
  });
};

/**
 * Pushes `task` to its configs not yet notified, if it has ended. Never
 * throws: a push is fire-and-forget beside the run or call that noticed the
 * end.
 */
const pushTaskIfEnded = async (row: TaskRow): Promise<void> => {
  try {
    const task = await readTask(row);
    if (!TERMINAL_TASK_STATES.has(task.status!.state)) return;
    const claimed = await db
      .update(a2aPushConfigTable)
      .set({ notifiedAt: new Date() })
      .where(pending(row.id))
      .returning();
    await Promise.all(claimed.map((config) => deliver(config, task)));
  } catch (error) {
    logger.error({ error, taskId: row.id }, "A2A push notification failed");
  }
};

/**
 * A run in the Chat has ended — on its own, or marked failed by the sweep
 * after its instance died: push each of the Chat's Tasks that has ended and
 * still owes a push. Never throws.
 */
export const pushA2aChatEnded = async (chatId: string): Promise<void> => {
  try {
    const tasks: TaskRow[] = await db
      .select({
        id: a2aTaskTable.id,
        chatId: a2aTaskTable.chatId,
        messageId: a2aTaskTable.messageId,
        endpointId: a2aTaskTable.endpointId,
        tokenId: a2aTaskTable.tokenId,
        createdAt: a2aTaskTable.createdAt,
      })
      .from(a2aTaskTable)
      .innerJoin(
        a2aPushConfigTable,
        eq(a2aPushConfigTable.taskId, a2aTaskTable.id),
      )
      .where(
        and(
          eq(a2aTaskTable.chatId, chatId),
          isNull(a2aPushConfigTable.notifiedAt),
        ),
      );
    const unique = new Map(tasks.map((task) => [task.id, task]));
    await Promise.all([...unique.values()].map(pushTaskIfEnded));
  } catch (error) {
    logger.error({ error, chatId }, "A2A push notification failed");
  }
};

// ------------------------------------------------------------ Client config

/** How many push configs one Task takes. Each is a delivery when it ends. */
const MAX_PUSH_CONFIGS_PER_TASK = 5;

/** An HTTP auth scheme name (RFC 9110 `token`). */
const AUTH_SCHEME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Whether `value` holds a control character, which would break a header. */
const hasControlChar = (value: string) =>
  [...value].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);

/** A client's push config, checked and ready to store. */
export type CheckedPushConfig = {
  id: string;
  url: string;
  token: string | null;
  authentication: A2aPushAuthentication | null;
};

/**
 * Refuses a push config that could never be delivered: a URL that is not
 * http(s), one the egress guard blocks, or credentials that are not a valid
 * header. Delivery re-checks the URL regardless, since DNS can change. As with
 * a Webhook URL, the reason a URL is refused goes to the log, not the caller.
 */
export const checkPushConfig = async (
  config: TaskPushNotificationConfig,
): Promise<CheckedPushConfig> => {
  if (!config.url) {
    throw new RequestMalformedError("A push notification config needs a url");
  }
  const egress = await checkEgress(config.url);
  if (!egress.allowed) {
    logger.warn(
      { url: config.url, reason: egress.reason },
      "Rejected an A2A push notification URL by network policy",
    );
    throw new RequestMalformedError(
      "This URL is not permitted by this deployment's network policy.",
    );
  }
  const auth = config.authentication;
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
    authentication:
      auth?.scheme && auth.credentials
        ? { scheme: auth.scheme, credentials: auth.credentials }
        : null,
  };
};

/**
 * Stores a checked config on `task`, replacing one with the same id. A config
 * without an id replaces one with the same URL, so a `SendMessage` retried
 * with its config registers it once. A replacement to the same URL keeps its
 * delivery, so re-registering never pushes an ended Task twice. If the Task
 * has already ended and the config is new, it is pushed now: a run can end
 * before its client registers.
 */
export const storePushConfig = async (
  task: TaskRow,
  config: CheckedPushConfig,
): Promise<PushConfigRow> => {
  const values = {
    url: config.url,
    token: config.token,
    authentication: config.authentication,
  };
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
      const [updated] = await tx
        .update(a2aPushConfigTable)
        .set({
          ...values,
          notifiedAt: existing.url === config.url ? existing.notifiedAt : null,
        })
        .where(configKey(task.id, existing.id))
        .returning();
      return updated;
    }

    // ponytail: a soft cap. Two registrations racing can each see room for
    // one more; lock the Task row if that matters.
    const [{ n }] = await tx
      .select({ n: count() })
      .from(a2aPushConfigTable)
      .where(eq(a2aPushConfigTable.taskId, task.id));
    if (n >= MAX_PUSH_CONFIGS_PER_TASK) {
      throw new RequestMalformedError(
        `A Task takes at most ${MAX_PUSH_CONFIGS_PER_TASK} push notification configs`,
      );
    }
    const [inserted] = await tx
      .insert(a2aPushConfigTable)
      .values({ id: config.id || randomUUID(), taskId: task.id, ...values })
      .returning();
    return inserted;
  });
  if (!row.notifiedAt) void pushTaskIfEnded(task);
  return row;
};

/** A stored config as the client reads it back. */
const toWire = (row: PushConfigRow): TaskPushNotificationConfig => ({
  tenant: "",
  id: row.id,
  taskId: row.taskId,
  url: row.url,
  token: row.token ?? "",
  authentication: row.authentication ?? undefined,
});

/** One of the endpoint's Tasks; another endpoint's is not found. */
const endpointTask = async (endpointId: string, taskId: string) => {
  const [task] = await db
    .select()
    .from(a2aTaskTable)
    .where(
      and(eq(a2aTaskTable.id, taskId), eq(a2aTaskTable.endpointId, endpointId)),
    )
    .limit(1);
  if (!task) throw new TaskNotFoundError();
  return task;
};

/** `CreateTaskPushNotificationConfig`. */
export const createA2aPushConfig = async (
  endpointId: string,
  params: TaskPushNotificationConfig,
): Promise<TaskPushNotificationConfig> => {
  const task = await endpointTask(endpointId, params.taskId);
  return toWire(await storePushConfig(task, await checkPushConfig(params)));
};

/** `GetTaskPushNotificationConfig`. */
export const getA2aPushConfig = async (
  endpointId: string,
  params: { taskId: string; id: string },
): Promise<TaskPushNotificationConfig> => {
  const task = await endpointTask(endpointId, params.taskId);
  const [row] = await db
    .select()
    .from(a2aPushConfigTable)
    .where(configKey(task.id, params.id))
    .limit(1);
  // A2A has no error of its own for a missing config; the SDK's handler
  // answers this one too.
  if (!row) throw new TaskNotFoundError("Push notification config not found");
  return toWire(row);
};

/** `ListTaskPushNotificationConfigs`: all of them, in one page. */
export const listA2aPushConfigs = async (
  endpointId: string,
  params: { taskId: string },
) => {
  const task = await endpointTask(endpointId, params.taskId);
  const rows = await db
    .select()
    .from(a2aPushConfigTable)
    .where(eq(a2aPushConfigTable.taskId, task.id))
    .orderBy(asc(a2aPushConfigTable.createdAt));
  return { configs: rows.map(toWire), nextPageToken: "" };
};

/** `DeleteTaskPushNotificationConfig`. */
export const deleteA2aPushConfig = async (
  endpointId: string,
  params: { taskId: string; id: string },
): Promise<void> => {
  const task = await endpointTask(endpointId, params.taskId);
  await db.delete(a2aPushConfigTable).where(configKey(task.id, params.id));
};
