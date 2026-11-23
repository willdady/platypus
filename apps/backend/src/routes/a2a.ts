import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { etag } from "hono/etag";
import {
  JsonRpcTransportHandler,
  ServerCallContext,
  type A2ARequestHandler,
} from "@a2a-js/sdk/server";
import { A2AError, VersionNotSupportedError } from "@a2a-js/sdk/errors";
import { AgentCard, type StreamResponse, type Task } from "@a2a-js/sdk";
import {
  A2A_PROTOCOL_VERSION,
  lookupA2aEndpoint,
  publicAgentCard,
} from "../services/a2a-endpoint.ts";
import { authenticateA2aCall } from "../services/a2a-token.ts";
import { cancelA2aTask } from "../services/a2a-cancel.ts";
import {
  A2aChatBusyError,
  getA2aTask,
  listA2aTasks,
  sendA2aMessage,
  withNullDataParts,
  type A2aCaller,
} from "../services/a2a-task.ts";
import {
  checkPushConfig,
  createA2aPushConfig,
  deleteA2aPushConfig,
  getA2aPushConfig,
  listA2aPushConfigs,
} from "../services/a2a-push.ts";
import { chatIdOf, findA2aTask } from "../services/a2a-task-state.ts";
import { taskStatus } from "../services/a2a-task-lifecycle.ts";
import {
  streamA2aMessage,
  subscribeToA2aTask,
} from "../services/a2a-stream.ts";
import { withHeartbeatFrames } from "../runs/stream-keepalive.ts";
import {
  A2A_RETRY_AFTER_SECONDS,
  A2aAtCapacityError,
  AGENT_CARD_METHOD,
  a2aSettings,
  logA2aCall,
  readRpcEnvelope,
  reasonOfRpcCode,
  type A2aCallLogEntry,
} from "../services/a2a-call.ts";
import { logger } from "../logger.ts";
import { backendBaseUrl } from "../base-urls.ts";
import { errorMessage } from "../utils/error-message.ts";
import type { Variables } from "../server.ts";

const a2a = new Hono<{ Variables: Variables }>();

const withCallLog = async (
  log: A2aCallLogEntry,
  answer: () => Promise<Response>,
): Promise<Response> => {
  try {
    return await answer();
  } catch (error) {
    log.outcome = "rejected";
    log.reason = "internal_error";
    throw error;
  } finally {
    logA2aCall(log);
  }
};

const AGENT_CARD_CACHE_SECONDS = 5 * 60;

a2a.get("/:endpointId/.well-known/agent-card.json", etag(), (c) => {
  const log: A2aCallLogEntry = {
    endpointId: c.req.param("endpointId"),
    method: AGENT_CARD_METHOD,
    outcome: "rejected",
  };
  return withCallLog(log, async () => {
    const lookup = await lookupA2aEndpoint(log.endpointId);
    log.organizationId = lookup.organizationId;
    log.workspaceId = lookup.workspaceId;
    if (!lookup.live) {
      log.reason = lookup.reason;
      return c.json({ error: "Not Found" }, 404);
    }
    log.outcome = "ok";
    c.header("Cache-Control", `private, max-age=${AGENT_CARD_CACHE_SECONDS}`);
    return c.json(publicAgentCard(lookup.endpoint));
  });
});

const guardedFor =
  (log: A2aCallLogEntry) =>
  <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
  async (...args: A): Promise<R> => {
    try {
      const result = await fn(...args);
      noteIds(log, args[0], result);
      return result;
    } catch (error) {
      throw refusal(log, error);
    }
  };

const guardedStreamFor =
  (log: A2aCallLogEntry) =>
  <A extends unknown[]>(fn: (...args: A) => AsyncGenerator<StreamResponse>) =>
    async function* (...args: A): AsyncGenerator<StreamResponse> {
      try {
        for await (const event of fn(...args)) {
          if (event.payload?.$case === "task") {
            noteIds(log, args[0], event.payload.value);
          }
          yield event;
        }
      } catch (error) {
        throw refusal(log, error);
      }
    };

const refusal = (log: A2aCallLogEntry, error: unknown): unknown => {
  if (error instanceof A2aAtCapacityError) {
    log.outcome = "rate_limited";
    return error;
  }
  if (error instanceof A2aChatBusyError) {
    log.reason = "busy";
    log.taskId = error.taskId;
    return error;
  }
  if (error instanceof A2AError) return error;
  logger.error({ error }, "A2A call failed");
  log.reason = "internal_error";
  return new Error("Internal error", { cause: error });
};

const noteIds = (log: A2aCallLogEntry, params: unknown, result: unknown) => {
  const task = result as Task | undefined;
  if (typeof task?.id === "string" && typeof task.contextId === "string") {
    log.taskId = task.id;
    log.chatId = chatIdOf(task);
    return;
  }
  const { taskId } = (params ?? {}) as { taskId?: unknown };
  if (typeof taskId === "string") log.taskId = taskId;
};

const requestHandler = (
  caller: A2aCaller,
  nullDataParts: ReadonlySet<number>,
  guarded: ReturnType<typeof guardedFor>,
  guardedStream: ReturnType<typeof guardedStreamFor>,
): A2ARequestHandler => ({
  getAgentCard: () =>
    Promise.resolve(AgentCard.fromJSON(publicAgentCard(caller.endpoint))),
  getAuthenticatedExtendedAgentCard: () =>
    Promise.resolve(AgentCard.fromJSON(publicAgentCard(caller.endpoint))),
  sendMessage: guarded((params) =>
    sendA2aMessage(caller, withNullDataParts(params, nullDataParts)),
  ),
  getTask: guarded((params) => getA2aTask(caller, params)),
  sendMessageStream: guardedStream((params) =>
    streamA2aMessage(caller, withNullDataParts(params, nullDataParts)),
  ),
  resubscribe: guardedStream((params) => subscribeToA2aTask(caller, params.id)),
  cancelTask: guarded((params) => cancelA2aTask(caller, params.id)),
  createTaskPushNotificationConfig: guarded(async (params) => {
    // why: check before taskStatus, which records the Task's end, so a refused config records nothing
    const task = await findA2aTask(caller, params.taskId);
    checkPushConfig(params);
    await taskStatus(task);
    return createA2aPushConfig(caller, params);
  }),
  getTaskPushNotificationConfig: guarded((params) =>
    getA2aPushConfig(caller, params),
  ),
  listTaskPushNotificationConfigs: guarded((params) =>
    listA2aPushConfigs(caller, params),
  ),
  deleteTaskPushNotificationConfig: guarded((params) =>
    deleteA2aPushConfig(caller, params),
  ),
  listTasks: guarded((params) => listA2aTasks(caller, params)),
});

type JSONRPCResponse = Exclude<
  Awaited<ReturnType<JsonRpcTransportHandler["handle"]>>,
  AsyncGenerator<unknown, void, undefined>
>;

const encoder = new TextEncoder();
const sseFrame = (event: JSONRPCResponse, name?: string) =>
  encoder.encode(
    `${name ? `event: ${name}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
  );

const eventStream = async (
  id: string | number,
  events: AsyncGenerator<JSONRPCResponse, void, undefined>,
  hangUp: AbortController,
): Promise<Response | JSONRPCResponse> => {
  const failure = (error: unknown): JSONRPCResponse => ({
    jsonrpc: "2.0",
    id,
    error: JsonRpcTransportHandler.mapToJSONRPCError(error),
  });
  let first: IteratorResult<JSONRPCResponse, void>;
  try {
    first = await events.next();
  } catch (error) {
    return failure(error);
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (first.done) controller.close();
      else controller.enqueue(sseFrame(first.value));
    },
    async pull(controller) {
      try {
        const next = await events.next();
        if (next.done) controller.close();
        else controller.enqueue(sseFrame(next.value));
      } catch (error) {
        controller.enqueue(sseFrame(failure(error), "error"));
        controller.close();
      }
    },
    cancel() {
      hangUp.abort();
      void events.return();
    },
  });
  return new Response(withHeartbeatFrames(stream), {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
};

const versionRefusal = (
  id: string | number,
  version: string | undefined,
): JSONRPCResponse | undefined => {
  if (!version) return undefined;
  const requested = version.split(".").slice(0, 2).join(".");
  if (requested === A2A_PROTOCOL_VERSION) return undefined;
  return {
    jsonrpc: "2.0",
    id,
    error: JsonRpcTransportHandler.mapToJSONRPCError(
      new VersionNotSupportedError(
        `The requested A2A protocol version '${requested}' is not supported. Supported versions: ${A2A_PROTOCOL_VERSION}`,
      ),
    ),
  };
};

const bodyTooLarge = (c: Context) => {
  const log: A2aCallLogEntry = {
    endpointId: c.req.param("endpointId") ?? "",
    outcome: "rejected",
    reason: "body_too_large",
  };
  return withCallLog(log, async () => {
    try {
      const lookup = await lookupA2aEndpoint(log.endpointId);
      log.organizationId = lookup.organizationId;
      log.workspaceId = lookup.workspaceId;
    } catch (error) {
      logger.error(
        { endpointId: log.endpointId, error: errorMessage(error) },
        "Failed to look up the A2A endpoint an oversized call named",
      );
    }
    return c.json({ error: "Payload Too Large" }, 413);
  });
};

const capBody: MiddlewareHandler = (c, next) =>
  bodyLimit({
    maxSize: a2aSettings().maxBodyBytes,
    onError: bodyTooLarge,
  })(c, next);

a2a.on("POST", ["/:endpointId", "/:endpointId/"], capBody, (c) => {
  const log: A2aCallLogEntry = {
    endpointId: c.req.param("endpointId"),
    outcome: "rejected",
  };
  return withCallLog(log, () => answerRpc(c, log));
});

const answerRpc = async (c: Context, log: A2aCallLogEntry) => {
  const envelope = readRpcEnvelope(await c.req.text());
  log.method = envelope.method;
  const auth = await authenticateA2aCall(
    log.endpointId,
    c.req.header("Authorization"),
  );
  if (!auth.ok) {
    log.reason = auth.reason;
    if (auth.status === 404) {
      log.organizationId = auth.organizationId;
      log.workspaceId = auth.workspaceId;
      return c.json({ error: "Not Found" }, 404);
    }
    log.organizationId = auth.endpoint.organizationId;
    log.workspaceId = auth.endpoint.workspaceId;
    log.tokenId = auth.tokenId;
    c.header("WWW-Authenticate", "Bearer");
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { endpoint, token } = auth;
  log.organizationId = endpoint.organizationId;
  log.workspaceId = endpoint.workspaceId;
  log.tokenId = token.id;
  if (envelope.kind === "malformed") {
    log.reason = reasonOfRpcCode(envelope.error.code);
    return c.json({ jsonrpc: "2.0", id: envelope.id, error: envelope.error });
  }
  if (envelope.kind === "notification") {
    log.reason = "notification";
    return c.body(null, 204);
  }
  const hangUp = new AbortController();
  c.req.raw.signal.addEventListener("abort", () => hangUp.abort(), {
    once: true,
  });
  const transport = new JsonRpcTransportHandler(
    requestHandler(
      { endpoint, token, origin: backendBaseUrl(), signal: hangUp.signal },
      envelope.nullDataParts,
      guardedFor(log),
      guardedStreamFor(log),
    ),
  );
  let response =
    versionRefusal(envelope.id, c.req.header("A2A-Version")) ??
    (await transport.handle(envelope.request, new ServerCallContext()));
  if (Symbol.asyncIterator in response) {
    const answer = await eventStream(envelope.id, response, hangUp);
    if (answer instanceof Response) {
      log.outcome = "ok";
      return answer;
    }
    response = answer;
  }

  if (log.outcome === "rate_limited") {
    c.header("Retry-After", String(A2A_RETRY_AFTER_SECONDS));
    return c.json({ error: "Too Many Requests" }, 429);
  }
  const error = "error" in response ? response.error : undefined;
  if (error) {
    log.reason ??= reasonOfRpcCode((error as { code: number }).code);
  } else {
    log.outcome = "ok";
  }
  return c.json(response);
};

export { a2a };
