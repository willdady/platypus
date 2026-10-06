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
import type { RunStatus } from "../runs/types.ts";
import type { A2aCaller } from "./a2a-task.ts";
import {
  currentTurnId,
  findTokenTask,
  readTask,
  recordTaskEnd,
  TERMINAL_TASK_STATES,
  type TaskRow,
} from "./a2a-task-state.ts";
import { postWithRetries } from "./webhook-delivery.ts";
import { taskIsLive } from "./a2a-liveness.ts";

/**
 * A2A push notifications (ADR-0032): when a Task ends — `completed`, `failed`
 * or `canceled` — it is POSTed to every URL its client registered, with the
 * credentials the client supplied, over the Webhook transport (its egress
 * guard and retries). Nothing is pushed for an intermediate state.
 *
 * Each config is delivered once. Its `notifiedAt` is claimed before sending,
 * so the run's end and a registration landing just after it can't both push,
 * and a Task sends at most `MAX_PUSHES_PER_TASK` however its configs churn.
 *
 * The URL and credentials come from an outside caller, so a push reaches
 * private networks only when the Operator opts in with
 * `A2A_PUSH_ALLOW_PRIVATE_NETWORKS`, whatever `EGRESS_ALLOW_PRIVATE_NETWORKS`
 * allows Webhooks. The URL is checked when it is delivered, not when it is
 * registered: a refusal goes to the log, so a caller can't tell a host that
 * doesn't resolve from one that resolves somewhere internal.
 *
 * A Task whose token or endpoint was cut off before its push pushes nothing:
 * its configs are marked delivered, so nothing retries them.
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

/** Whether the Operator lets A2A pushes reach private networks. */
const privateNetworksAllowed = () =>
  ["true", "1"].includes(
    process.env.A2A_PUSH_ALLOW_PRIVATE_NETWORKS?.trim().toLowerCase() ?? "",
  );

/**
 * How many pushes this instance sends at once, retries included. More wait
 * their turn, so a burst of ended Tasks can't fan out unbounded requests.
 */
export const MAX_CONCURRENT_PUSHES = 8;
let pushesInFlight = 0;
const waitingForSlot: (() => void)[] = [];

/** Runs `send` once one of the instance's push slots is free. */
const withPushSlot = async (send: () => Promise<void>): Promise<void> => {
  if (pushesInFlight < MAX_CONCURRENT_PUSHES) pushesInFlight++;
  else await new Promise<void>((resolve) => waitingForSlot.push(resolve));
  try {
    await send();
  } finally {
    // The slot passes straight to the next in line, if any.
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

/** How many pushes one Task sends, over every config it has had. */
const MAX_PUSHES_PER_TASK = 5;

/**
 * Takes up to `wanted` of the Task's remaining pushes and returns how many it
 * got. A compare-and-set on the Task's count, so two instances pushing the
 * same Task can't both take the last one.
 */
const reservePushes = async (
  taskId: string,
  wanted: number,
): Promise<number> => {
  // A lost compare-and-set means another caller took at least one push, so
  // this many attempts always reach an answer.
  for (let attempt = 0; attempt <= MAX_PUSHES_PER_TASK; attempt++) {
    const [task] = await db
      .select({ pushCount: a2aTaskTable.pushCount })
      .from(a2aTaskTable)
      .where(eq(a2aTaskTable.id, taskId))
      .limit(1);
    if (!task) return 0;
    // Never null in Postgres; the tests' in-memory db skips column defaults.
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
    if (claimed.length === 0) return;
    // Read afresh: a token or endpoint deleted since leaves the row's null.
    const [current] = await db
      .select()
      .from(a2aTaskTable)
      .where(eq(a2aTaskTable.id, row.id))
      .limit(1);
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

/**
 * A run in the Chat has ended, or a Task in it was canceled: push each of the
 * Chat's Tasks that has ended and still owes a push. Never throws.
 */
export const pushEndedA2aTasks = async (chatId: string): Promise<void> => {
  try {
    const tasks: TaskRow[] = await db
      .select({
        id: a2aTaskTable.id,
        chatId: a2aTaskTable.chatId,
        messageId: a2aTaskTable.messageId,
        endpointId: a2aTaskTable.endpointId,
        tokenId: a2aTaskTable.tokenId,
        state: a2aTaskTable.state,
        canceledAt: a2aTaskTable.canceledAt,
        statusAt: a2aTaskTable.statusAt,
        pushCount: a2aTaskTable.pushCount,
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

/**
 * A turn in the Chat has ended with `status` — on its own, or marked failed by
 * the sweep after its instance died. Records the end on the turn's Task, if it
 * has one, then pushes. `messageId` names the turn; without it, the Chat's
 * current turn. Never throws.
 */
export const onA2aTurnEnded = async ({
  chatId,
  messageId,
  status,
}: {
  chatId: string;
  messageId?: string | null;
  status: RunStatus;
}): Promise<void> => {
  try {
    const turnId = messageId ?? (await currentTurnId(chatId));
    if (turnId) await recordTaskEnd(chatId, turnId, status);
  } catch (error) {
    logger.error({ error, chatId }, "Recording an A2A Task's end failed");
  }
  await pushEndedA2aTasks(chatId);
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

/** Whether `value` parses as an http(s) URL with a host. */
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

/**
 * Refuses a push config that could never be delivered: a URL that is not
 * http(s), or credentials that are not a valid header. Where the URL leads is
 * not looked at here: delivery checks it against the egress guard and logs a
 * refusal, so every host the caller names gets the same answer.
 */
export const checkPushConfig = (
  config: TaskPushNotificationConfig,
): CheckedPushConfig => {
  if (!config.url || !isHttpUrl(config.url)) {
    throw new RequestMalformedError(
      "A push notification config needs an http or https url",
    );
  }
  const auth = config.authentication;
  if (!auth?.scheme !== !auth?.credentials) {
    throw new RequestMalformedError(
      "Push notification authentication needs both a scheme and credentials",
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
    authentication:
      auth?.scheme && auth.credentials
        ? { scheme: auth.scheme, credentials: auth.credentials }
        : null,
  };
};

/**
 * Stores a checked config on `task`, replacing one with the same id. A config
 * without an id replaces one with the same URL, so a `SendMessage` retried
 * with its config registers it once. A replacement keeps its delivery, so
 * re-registering never pushes a config twice; one that would move a config's
 * URL once its Task has ended is refused, so it can't be aimed somewhere new.
 * If the Task has already ended and the config is new, it is pushed now: a run
 * can end before its client registers.
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
  const ended = TERMINAL_TASK_STATES.has((await readTask(task)).status!.state);
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
    // An upsert: a registration of the same id that raced this one in since
    // the check above is replaced, as it would have been had it landed first —
    // unless it has been delivered and this moves its URL, refused as above.
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
  if (!row.notifiedAt) void pushTaskIfEnded(task);
  return row;
};

/**
 * A stored config as the client reads it back. The secrets it registered —
 * the token and the credentials — are never returned: only the scheme.
 */
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

/** One of the calling token's Tasks; any other is not found. */
const callerTask = (caller: A2aCaller, taskId: string) =>
  findTokenTask(
    { endpointId: caller.endpoint.id, tokenId: caller.token.id },
    taskId,
  );

/** `CreateTaskPushNotificationConfig`. */
export const createA2aPushConfig = async (
  caller: A2aCaller,
  params: TaskPushNotificationConfig,
): Promise<TaskPushNotificationConfig> => {
  const task = await callerTask(caller, params.taskId);
  return toWire(await storePushConfig(task, checkPushConfig(params)));
};

/** `GetTaskPushNotificationConfig`. */
export const getA2aPushConfig = async (
  caller: A2aCaller,
  params: { taskId: string; id: string },
): Promise<TaskPushNotificationConfig> => {
  const task = await callerTask(caller, params.taskId);
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
  caller: A2aCaller,
  params: { taskId: string },
) => {
  const task = await callerTask(caller, params.taskId);
  const rows = await db
    .select()
    .from(a2aPushConfigTable)
    .where(eq(a2aPushConfigTable.taskId, task.id))
    .orderBy(asc(a2aPushConfigTable.createdAt));
  return { configs: rows.map(toWire), nextPageToken: "" };
};

/** `DeleteTaskPushNotificationConfig`. */
export const deleteA2aPushConfig = async (
  caller: A2aCaller,
  params: { taskId: string; id: string },
): Promise<void> => {
  const task = await callerTask(caller, params.taskId);
  await db.delete(a2aPushConfigTable).where(configKey(task.id, params.id));
};
