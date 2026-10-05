import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { etag } from "hono/etag";
import {
  JsonRpcTransportHandler,
  ServerCallContext,
  validateVersion,
  type A2ARequestHandler,
} from "@a2a-js/sdk/server";
import { A2AError, UnsupportedOperationError } from "@a2a-js/sdk/errors";
import { AgentCard, type StreamResponse } from "@a2a-js/sdk";
import {
  extendedAgentCard,
  lookupA2aEndpoint,
  publicAgentCard,
} from "../services/a2a-endpoint.ts";
import { authenticateA2aCall } from "../services/a2a-token.ts";
import { cancelA2aTask } from "../services/a2a-cancel.ts";
import {
  A2aChatBusyError,
  getA2aTask,
  sendA2aMessage,
  type A2aCaller,
} from "../services/a2a-task.ts";
import {
  createA2aPushConfig,
  deleteA2aPushConfig,
  getA2aPushConfig,
  listA2aPushConfigs,
} from "../services/a2a-push.ts";
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
  reasonOfRpcCode,
  rpcMethodOf,
  type A2aCallLogEntry,
} from "../services/a2a-call.ts";
import { logger } from "../logger.ts";
import { getOrigin } from "../utils/get-origin.ts";
import { errorMessage } from "../utils/error-message.ts";
import type { Variables } from "../server.ts";

/**
 * `/a2a/*` — A2A endpoints as outside clients reach them (ADR-0032). Mounted
 * outside `/organizations/...` and outside session auth, so an Operator can
 * expose this prefix alone, as with `/hooks/*`.
 *
 * An endpoint that is unknown, disabled or deleted, whose Workspace the
 * Organization's A2A gate excludes, or whose Owner has left the Organization,
 * is the same `404` with the same body, for the card and every method.
 *
 * Every call, the card included, writes exactly one call-log line.
 */
const a2a = new Hono<{ Variables: Variables }>();

/**
 * Answers a call and writes its log line, whatever became of it. Each path in
 * `answer` fills `log` as it returns, so a throw means the backend failed.
 */
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

/**
 * The public Agent Card. Needs no token: the URL is the secret. Cacheable for
 * a few minutes, so an edit to the endpoint's name or description can take
 * that long to reach a client; a cached card opens nothing once the endpoint
 * stops answering.
 */
a2a.get("/:endpointId/.well-known/agent-card.json", etag(), (c) => {
  const log: A2aCallLogEntry = {
    endpointId: c.req.param("endpointId"),
    method: AGENT_CARD_METHOD,
    outcome: "rejected",
  };
  return withCallLog(log, async () => {
    const lookup = await lookupA2aEndpoint(log.endpointId);
    log.organizationId = lookup.live
      ? lookup.endpoint.organizationId
      : lookup.organizationId;
    log.workspaceId = lookup.live
      ? lookup.endpoint.workspaceId
      : lookup.workspaceId;
    if (!lookup.live) {
      log.reason = lookup.reason;
      return c.json({ error: "Not Found" }, 404);
    }
    log.outcome = "ok";
    c.header("Cache-Control", "private, max-age=300");
    return c.json(publicAgentCard(lookup.endpoint));
  });
});

const unsupported = (): never => {
  throw new UnsupportedOperationError();
};

/**
 * Wraps each method for one call. Our errors reach the caller as A2A errors;
 * anything else is logged and answered as a bare internal error, so no
 * internal detail leaves the server. What the method returned or refused is
 * noted on the call's log line: its Task and Chat, or why it was refused.
 */
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

/**
 * `guardedFor`, for a method that answers with a stream of events. Its Task
 * and Chat are noted from its first event, the Task.
 */
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

/** Notes why a method failed on the call's log line; returns what to throw. */
const refusal = (log: A2aCallLogEntry, error: unknown): unknown => {
  if (error instanceof A2aAtCapacityError) {
    log.outcome = "rate_limited";
    return error;
  }
  if (error instanceof A2aChatBusyError) {
    // The running Task the refusal names, for the client to follow.
    log.reason = "busy";
    log.taskId = error.taskId;
    return error;
  }
  if (error instanceof A2AError) return error;
  logger.error({ error }, "A2A call failed");
  log.reason = "internal_error";
  return new Error("Internal error", { cause: error });
};

/**
 * The Task and Chat a method answered with: a Task names both, and a push
 * config method names the Task its params named, which it found.
 */
const noteIds = (log: A2aCallLogEntry, params: unknown, result: unknown) => {
  const task = result as { id?: unknown; contextId?: unknown } | undefined;
  if (typeof task?.id === "string" && typeof task.contextId === "string") {
    log.taskId = task.id;
    log.chatId = task.contextId;
    return;
  }
  const { taskId } = (params ?? {}) as { taskId?: unknown };
  if (typeof taskId === "string") log.taskId = taskId;
};

/**
 * The JSON-RPC methods, answered from the database. `ListTasks` is
 * unsupported; an unknown method is JSON-RPC "method not found".
 */
const requestHandler = (
  caller: A2aCaller,
  guarded: ReturnType<typeof guardedFor>,
  guardedStream: ReturnType<typeof guardedStreamFor>,
): A2ARequestHandler => ({
  // Our cards are wire JSON; the transport serializes from the SDK's shape.
  getAgentCard: () =>
    Promise.resolve(AgentCard.fromJSON(publicAgentCard(caller.endpoint))),
  getAuthenticatedExtendedAgentCard: () =>
    Promise.resolve(AgentCard.fromJSON(extendedAgentCard(caller.endpoint))),
  sendMessage: guarded((params) => sendA2aMessage(caller, params)),
  getTask: guarded((params) => getA2aTask(caller, params.id)),
  sendMessageStream: guardedStream((params) =>
    streamA2aMessage(caller, params),
  ),
  resubscribe: guardedStream((params) => subscribeToA2aTask(caller, params.id)),
  cancelTask: guarded((params) => cancelA2aTask(caller, params.id)),
  createTaskPushNotificationConfig: guarded((params) =>
    createA2aPushConfig(caller.endpoint.id, params),
  ),
  getTaskPushNotificationConfig: guarded((params) =>
    getA2aPushConfig(caller.endpoint.id, params),
  ),
  listTaskPushNotificationConfigs: guarded((params) =>
    listA2aPushConfigs(caller.endpoint.id, params),
  ),
  deleteTaskPushNotificationConfig: guarded((params) =>
    deleteA2aPushConfig(caller.endpoint.id, params),
  ),
  listTasks: unsupported,
});

/** What the transport answers a call with; the SDK does not export it. */
type JSONRPCResponse = Exclude<
  Awaited<ReturnType<JsonRpcTransportHandler["handle"]>>,
  AsyncGenerator<unknown, void, undefined>
>;

/** The id a JSON-RPC body names, or `null` if it names none or isn't JSON. */
const rpcIdOf = (body: string): string | number | null => {
  try {
    return (JSON.parse(body) as { id?: string | number | null }).id ?? null;
  } catch {
    return null;
  }
};

const encoder = new TextEncoder();
const sseFrame = (event: JSONRPCResponse, name?: string) =>
  encoder.encode(
    `${name ? `event: ${name}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
  );

/**
 * A streaming method's answer. A call refused before its first event (a
 * refused message, an unknown or ended Task, the load cap) is answered with
 * its JSON-RPC error, as for any other method; after that, events go out as
 * SSE, kept alive while the run is silent. A client that hangs up stops the
 * stream, never the run.
 */
const eventStream = async (
  body: string,
  events: AsyncGenerator<JSONRPCResponse, void, undefined>,
): Promise<Response | JSONRPCResponse> => {
  const id = rpcIdOf(body);
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

/**
 * The JSON-RPC error for an `A2A-Version` the card doesn't declare, or
 * `undefined` to serve the call. A call with none is served: the spec reads a
 * missing version as 0.3, but refusing it would shut out every client that
 * never sends the header.
 */
const versionRefusal = (
  body: string,
  version: string | undefined,
  endpoint: A2aCaller["endpoint"],
): JSONRPCResponse | undefined => {
  if (!version) return undefined;
  try {
    // The spec matches versions by `Major.Minor`.
    validateVersion(
      version.split(".").slice(0, 2).join("."),
      AgentCard.fromJSON(publicAgentCard(endpoint)),
      "JSONRPC",
    );
    return undefined;
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id: rpcIdOf(body),
      error: JsonRpcTransportHandler.mapToJSONRPCError(error),
    };
  }
};

/**
 * Answers a body past the cap with its log line. The cap runs before the
 * token, so no token is named or stamped: a caller with none at all could
 * otherwise move an endpoint's "last rejected". The endpoint's ids are
 * best-effort; the line is owed whether or not the lookup works.
 */
const bodyTooLarge = (c: Context) => {
  const log: A2aCallLogEntry = {
    endpointId: c.req.param("endpointId") ?? "",
    outcome: "rejected",
    reason: "body_too_large",
  };
  return withCallLog(log, async () => {
    try {
      const lookup = await lookupA2aEndpoint(log.endpointId);
      log.organizationId = lookup.live
        ? lookup.endpoint.organizationId
        : lookup.organizationId;
      log.workspaceId = lookup.live
        ? lookup.endpoint.workspaceId
        : lookup.workspaceId;
    } catch (error) {
      logger.error(
        { endpointId: log.endpointId, error: errorMessage(error) },
        "Failed to look up the A2A endpoint an oversized call named",
      );
    }
    return c.json({ error: "Payload Too Large" }, 413);
  });
};

/**
 * The body cap is checked first, before the body is read or the token looked
 * at, so no caller can stream an unbounded body into memory. Read per call
 * like every other setting.
 */
const capBody: MiddlewareHandler = (c, next) =>
  bodyLimit({
    maxSize: a2aSettings().maxBodyBytes,
    onError: bodyTooLarge,
  })(c, next);

/**
 * JSON-RPC. A body past the cap is `413`. Every method then passes the token
 * check: a missing, wrong or expired token on a live endpoint is `401`, and
 * the token's last used or last rejected is stamped. A turn past the load cap
 * is `429`, having written nothing. A trailing slash is accepted, since some
 * clients join paths onto the URL as a base.
 */
a2a.on("POST", ["/:endpointId", "/:endpointId/"], capBody, (c) => {
  const log: A2aCallLogEntry = {
    // Always present: the path names it. `capBody` widens the context type.
    endpointId: c.req.param("endpointId") ?? "",
    outcome: "rejected",
  };
  return withCallLog(log, () => answerRpc(c, log));
});

const answerRpc = async (c: Context, log: A2aCallLogEntry) => {
  const body = await c.req.text();
  log.method = rpcMethodOf(body);
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
  const transport = new JsonRpcTransportHandler(
    requestHandler(
      { endpoint, token, origin: getOrigin(c) },
      guardedFor(log),
      guardedStreamFor(log),
    ),
  );
  let response =
    versionRefusal(body, c.req.header("A2A-Version"), endpoint) ??
    (await transport.handle(body, new ServerCallContext()));
  if (Symbol.asyncIterator in response) {
    const answer = await eventStream(body, response);
    // A stream is logged once it opens; how it goes on is the Task's to say.
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
  // The SDK types a JSON-RPC error loosely; its `code` is always a number.
  const error = "error" in response ? response.error : undefined;
  if (error) {
    log.reason ??= reasonOfRpcCode((error as { code: number }).code);
  } else {
    log.outcome = "ok";
  }
  return c.json(response);
};

export { a2a };
