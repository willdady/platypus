import { Hono } from "hono";
import {
  JsonRpcTransportHandler,
  ServerCallContext,
  type A2ARequestHandler,
} from "@a2a-js/sdk/server";
import { A2AError, UnsupportedOperationError } from "@a2a-js/sdk/errors";
import { AgentCard } from "@a2a-js/sdk";
import {
  extendedAgentCard,
  loadLiveA2aEndpoint,
  publicAgentCard,
} from "../services/a2a-endpoint.ts";
import { authenticateA2aCall } from "../services/a2a-token.ts";
import {
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
import { logger } from "../logger.ts";
import { getOrigin } from "../utils/get-origin.ts";
import type { Variables } from "../server.ts";

/**
 * `/a2a/*` — A2A endpoints as outside clients reach them (ADR-0032). Mounted
 * outside `/organizations/...` and outside session auth, so an Operator can
 * expose this prefix alone, as with `/hooks/*`.
 *
 * An endpoint that is unknown, disabled or deleted, whose Workspace the
 * Organization's A2A gate excludes, or whose Owner has left the Organization,
 * is the same `404` with the same body, for the card and every method.
 */
const a2a = new Hono<{ Variables: Variables }>();

/** The public Agent Card. Needs no token: the URL is the secret. */
a2a.get("/:endpointId/.well-known/agent-card.json", async (c) => {
  const endpoint = await loadLiveA2aEndpoint(c.req.param("endpointId"));
  if (!endpoint) return c.json({ error: "Not Found" }, 404);
  return c.json(publicAgentCard(endpoint));
});

const unsupported = (): never => {
  throw new UnsupportedOperationError();
};

/**
 * Our errors reach the caller as A2A errors; anything else is logged and
 * answered as a bare internal error, so no internal detail leaves the server.
 */
const guarded =
  <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
  async (...args: A): Promise<R> => {
    try {
      return await fn(...args);
    } catch (error) {
      if (error instanceof A2AError) throw error;
      logger.error({ error }, "A2A call failed");
      throw new Error("Internal error", { cause: error });
    }
  };

/** `guarded`, for a method that answers with a stream of events. */
const guardedStream = <A extends unknown[], R>(
  fn: (...args: A) => AsyncGenerator<R>,
) =>
  async function* (...args: A): AsyncGenerator<R> {
    try {
      yield* fn(...args);
    } catch (error) {
      if (error instanceof A2AError) throw error;
      logger.error({ error }, "A2A call failed");
      throw new Error("Internal error", { cause: error });
    }
  };

/**
 * The JSON-RPC methods, answered from the database. Methods other tickets
 * add (cancel) are unsupported until then; an unknown method is JSON-RPC
 * "method not found".
 */
const requestHandler = (caller: A2aCaller): A2ARequestHandler => ({
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
  cancelTask: unsupported,
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

const encoder = new TextEncoder();
const sseFrame = (event: JSONRPCResponse, name?: string) =>
  encoder.encode(
    `${name ? `event: ${name}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
  );

/**
 * A streaming method's answer. A call refused before its first event (a
 * refused message, an unknown or ended Task) is a plain JSON-RPC error, as
 * for any other method; after that, events go out as SSE, kept alive while
 * the run is silent. A client that hangs up stops the stream, never the run.
 */
const eventStream = async (
  body: string,
  events: AsyncGenerator<JSONRPCResponse, void, undefined>,
): Promise<Response> => {
  const id = (JSON.parse(body) as { id?: string | number | null }).id ?? null;
  const failure = (error: unknown): JSONRPCResponse => ({
    jsonrpc: "2.0",
    id,
    error: JsonRpcTransportHandler.mapToJSONRPCError(error),
  });
  let first: IteratorResult<JSONRPCResponse, void>;
  try {
    first = await events.next();
  } catch (error) {
    return Response.json(failure(error));
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
 * JSON-RPC. Every method passes the token check first: a missing, wrong or
 * expired token on a live endpoint is `401`, and the token's last used or
 * last rejected is stamped.
 */
a2a.post("/:endpointId", async (c) => {
  const auth = await authenticateA2aCall(
    c.req.param("endpointId"),
    c.req.header("Authorization"),
  );
  if (!auth.ok) {
    if (auth.status === 404) return c.json({ error: "Not Found" }, 404);
    c.header("WWW-Authenticate", "Bearer");
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { endpoint, token } = auth;
  const transport = new JsonRpcTransportHandler(
    requestHandler({ endpoint, token, origin: getOrigin(c) }),
  );
  const body = await c.req.text();
  const response = await transport.handle(body, new ServerCallContext());
  if (Symbol.asyncIterator in response) return eventStream(body, response);
  return c.json(response);
});

export { a2a };
