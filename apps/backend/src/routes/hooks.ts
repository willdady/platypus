import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Variables } from "../server.ts";
import { logger } from "../logger.ts";
import { errorMessage } from "../utils/error-message.ts";
import {
  acceptInboundCall,
  authenticateInboundCall,
  getInboundRunStatus,
  inboundTriggerSettings,
  INBOUND_RETRY_AFTER_SECONDS,
  loadInboundTarget,
  logInboundCall,
  touchInboundTrigger,
  validateInboundBody,
  type InboundAuthResult,
  type InboundRejectReason,
  type InboundTarget,
} from "../services/inbound-trigger.ts";

/**
 * `/hooks/*` — the ingress for callers that are not a browser session
 * (ADR-0030). Mounted outside `/organizations/...` and outside session auth,
 * so an Operator on a private network can expose this prefix alone through a
 * proxy or tunnel. Nothing here reads a session cookie.
 *
 * `POST /hooks/triggers/:triggerId` fires an Inbound Trigger and answers
 * `202 { runId, deduplicated }` before the run starts.
 * `GET /hooks/triggers/:triggerId/runs/:runId` polls that run.
 *
 * Every rejection a caller could use to learn what exists — an unknown
 * Trigger, a wrong, missing or expired token, a disabled Trigger, a closed
 * gate, a Trigger that is not inbound — is the same `404` with the same body.
 */
const hooks = new Hono<{ Variables: Variables }>();

/** The one body every "does not exist, as far as you know" answer carries. */
const NOT_FOUND_BODY = { error: "Not Found" } as const;

const notFound = (c: Context) => c.json(NOT_FOUND_BODY, 404);

const logContext = (target: InboundTarget | null) =>
  target
    ? {
        organizationId: target.organizationId,
        workspaceId: target.workspaceId,
      }
    : {};

/**
 * Logs a rejection, and stamps "last rejected" when it names a real Inbound
 * Trigger — how an Owner or Org Admin sees that something is calling with a
 * bad or expired token without searching the logs. An unknown id, or a
 * Trigger of another type, names no Inbound Trigger to stamp.
 *
 * The stamp is not awaited: a rejection aimed at a real Trigger must take as
 * long as one aimed at an unknown id, or the response time would tell a
 * caller without the token which ids exist. It never throws.
 */
const recordRejection = (
  triggerId: string,
  reason: InboundRejectReason,
  target: InboundTarget | null,
): void => {
  logInboundCall({
    triggerId,
    ...logContext(target),
    outcome: "rejected",
    reason,
  });
  if (target?.trigger.type === "inbound") {
    void touchInboundTrigger(triggerId, "lastRejectedAt");
  }
};

/**
 * The target a `413` names, for its log line. Best-effort: the line is owed
 * whether or not the lookup works, so a failed one logs without the ids.
 */
const loadTargetForLog = async (
  triggerId: string,
): Promise<InboundTarget | null> => {
  try {
    return await loadInboundTarget(triggerId);
  } catch (error) {
    logger.error(
      {
        triggerId,
        error: errorMessage(error),
      },
      "Failed to look up the inbound trigger an oversized call named",
    );
    return null;
  }
};

/**
 * Answers a body past the cap, logging it like any other rejection — but
 * never stamping "last rejected". The cap runs before the token, so a caller
 * with no token at all could otherwise move that time on any Trigger whose id
 * it knows, and it is how an Owner spots a leaked or stale token.
 */
const bodyTooLarge = async (c: Context) => {
  const triggerId = c.req.param("triggerId") ?? "";
  const target = await loadTargetForLog(triggerId);
  logInboundCall({
    triggerId,
    ...logContext(target),
    outcome: "rejected",
    reason: "body_too_large",
  });
  return c.json({ error: "Payload Too Large" }, 413);
};

/**
 * The body cap is checked first — before the token — and is the only size
 * limit: it bounds what reaches the Agent's context and run history. The cap
 * is the value the boot validation reported, read per call like every other
 * setting; building the limiter is a closure, not work worth caching.
 */
const capBody: MiddlewareHandler = (c, next) =>
  bodyLimit({
    maxSize: inboundTriggerSettings().maxBodyBytes,
    onError: bodyTooLarge,
  })(c, next);

hooks.post("/triggers/:triggerId", capBody, async (c) => {
  // Always present: the path names it. `capBody` widens the context type.
  const triggerId = c.req.param("triggerId") ?? "";
  try {
    return await fire(c, triggerId);
  } catch (error) {
    // Every call writes exactly one line. Each path in `fire` logs as it
    // returns, and nothing after a log line can throw, so a throw here means
    // none was written yet.
    logInboundCall({
      triggerId,
      outcome: "rejected",
      reason: "internal_error",
    });
    throw error;
  }
});

const fire = async (c: Context, triggerId: string) => {
  const raw = await c.req.text();

  const auth: InboundAuthResult = await authenticateInboundCall(
    triggerId,
    c.req.header("Authorization"),
  );
  if (!auth.ok) {
    recordRejection(triggerId, auth.reason, auth.target);
    return notFound(c);
  }
  const { target, config } = auth;

  let body: unknown;
  try {
    body = raw.trim() === "" ? undefined : JSON.parse(raw);
  } catch {
    recordRejection(triggerId, "invalid_inputs", target);
    return c.json({ error: "The request body is not valid JSON." }, 400);
  }
  const validated = validateInboundBody(body, config.inputs);
  if (!validated.ok) {
    recordRejection(triggerId, "invalid_inputs", target);
    return c.json({ error: validated.message }, 400);
  }

  // The record key's value, for the log line; validation proved it present.
  const recordKey =
    config.recordKey !== undefined
      ? validated.inputs[config.recordKey]
      : undefined;
  const acceptance = await acceptInboundCall(target, config, validated.inputs);

  if (acceptance.outcome === "rate_limited") {
    logInboundCall({
      triggerId,
      ...logContext(target),
      outcome: "rate_limited",
      recordKey,
    });
    // No "last rejected": it reports bad tokens, and this one was valid.
    c.header("Retry-After", String(INBOUND_RETRY_AFTER_SECONDS));
    return c.json({ error: "Too Many Requests" }, 429);
  }

  const deduplicated = acceptance.outcome === "deduplicated";
  logInboundCall({
    triggerId,
    ...logContext(target),
    outcome: acceptance.outcome,
    runId: acceptance.runId,
    deduplicated,
    recordKey,
  });
  // "Last used" is an accepted or deduplicated call (ADR-0030's brief); a
  // suppressed one is in the call log with its outcome.
  if (acceptance.outcome !== "suppressed") {
    await touchInboundTrigger(triggerId, "lastUsedAt");
  }
  return c.json({ runId: acceptance.runId, deduplicated }, 202);
};

hooks.get("/triggers/:triggerId/runs/:runId", async (c) => {
  const triggerId = c.req.param("triggerId");
  const auth = await authenticateInboundCall(
    triggerId,
    c.req.header("Authorization"),
  );
  if (!auth.ok) return notFound(c);

  const run = await getInboundRunStatus(triggerId, c.req.param("runId"));
  if (!run) return notFound(c);
  return c.json(run, 200);
});

export { hooks };
