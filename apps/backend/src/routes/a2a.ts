import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { etag } from "hono/etag";
import {
  JsonRpcTransportHandler,
  ServerCallContext,
  type A2ARequestHandler,
} from "@a2a-js/sdk/server";
import { A2AError, VersionNotSupportedError } from "@a2a-js/sdk/errors";
import { AgentCard, type StreamResponse } from "@a2a-js/sdk";
import {
  A2A_PROTOCOL_VERSION,
  extendedAgentCard,
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
  readRpcEnvelope,
  reasonOfRpcCode,
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
 * Organization's A2A gate excludes, or whose Owner has left the Organization
 * or is banned, is the same `404` with the same body, for the card and every
 * method. Cutting any of these off also stops the work already running: see
 * `a2a-liveness.ts`.
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
 * The JSON-RPC methods, answered from the database. An unknown method is
 * JSON-RPC "method not found".
 */
const requestHandler = (
  caller: A2aCaller,
  nullDataParts: ReadonlySet<number>,
  guarded: ReturnType<typeof guardedFor>,
  guardedStream: ReturnType<typeof guardedStreamFor>,
): A2ARequestHandler => ({
  // Our cards are wire JSON; the transport serializes from the SDK's shape.
  getAgentCard: () =>
    Promise.resolve(AgentCard.fromJSON(publicAgentCard(caller.endpoint))),
  getAuthenticatedExtendedAgentCard: () =>
    Promise.resolve(AgentCard.fromJSON(extendedAgentCard(caller.endpoint))),
  sendMessage: guarded((params) =>
    sendA2aMessage(caller, withNullDataParts(params, nullDataParts)),
  ),
  getTask: guarded((params) => getA2aTask(caller, params)),
  sendMessageStream: guardedStream((params) =>
    streamA2aMessage(caller, withNullDataParts(params, nullDataParts)),
  ),
  resubscribe: guardedStream((params) => subscribeToA2aTask(caller, params.id)),
  cancelTask: guarded((params) => cancelA2aTask(caller, params.id)),
  createTaskPushNotificationConfig: guarded((params) =>
    createA2aPushConfig(caller, params),
  ),
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

/** What the transport answers a call with; the SDK does not export it. */
type JSONRPCResponse = Exclude<
  Awaited<ReturnType<JsonRpcTransportHandler["handle"]>>,
  AsyncGenerator<unknown, void, undefined>
>;

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
 * stream, never the run: `hangUp` tells a follower polling its Task to let go
 * of its slot at once.
 */
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

/**
 * The JSON-RPC error for an `A2A-Version` the card doesn't declare, or
 * `undefined` to serve the call. A call with none is served: the spec reads a
 * missing version as 0.3, but refusing it would shut out every client that
 * never sends the header.
 */
const versionRefusal = (
  id: string | number,
  version: string | undefined,
): JSONRPCResponse | undefined => {
  if (!version) return undefined;
  // The spec matches versions by `Major.Minor`. Every card declares the one,
  // so no card is built to read it from.
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
 * the token's last used or last rejected is stamped. A turn past the run cap
 * is `429`, having written nothing; so is a follower past the follower cap.
 * A body that isn't JSON is `-32700` and one that isn't a JSON-RPC Request is
 * `-32600`; a Notification (no `id`) is `204` and is not run. A trailing slash
 * is accepted, since some clients join paths onto the URL as a base.
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
  // The body's one parse: everything after reads the envelope.
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
  // Checked here, not by the transport, which answers all of these -32602.
  if (envelope.kind === "malformed") {
    log.reason = reasonOfRpcCode(envelope.error.code);
    return c.json({ jsonrpc: "2.0", id: envelope.id, error: envelope.error });
  }
  // JSON-RPC 2.0 §4.1: a Notification is never answered, so it is never run:
  // a fire-and-forget SendMessage would start a run no one can follow.
  if (envelope.kind === "notification") {
    log.reason = "notification";
    return c.body(null, 204);
  }
  // Aborted when the client hangs up: on the request, or by canceling the
  // stream it was answered with.
  const hangUp = new AbortController();
  c.req.raw.signal?.addEventListener("abort", () => hangUp.abort(), {
    once: true,
  });
  const transport = new JsonRpcTransportHandler(
    requestHandler(
      { endpoint, token, origin: getOrigin(c), signal: hangUp.signal },
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
