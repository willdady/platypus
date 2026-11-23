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

const hooks = new Hono<{ Variables: Variables }>();

const NOT_FOUND_BODY = { error: "Not Found" } as const;

const notFound = (c: Context) => c.json(NOT_FOUND_BODY, 404);

const logContext = (target: InboundTarget | null) =>
  target
    ? {
        organizationId: target.organizationId,
        workspaceId: target.workspaceId,
      }
    : {};

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
    // why: not awaited, so a real Trigger's rejection takes as long as an unknown id's
    void touchInboundTrigger(triggerId, "lastRejectedAt");
  }
};

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

const capBody: MiddlewareHandler = (c, next) =>
  bodyLimit({
    maxSize: inboundTriggerSettings().maxBodyBytes,
    onError: bodyTooLarge,
  })(c, next);

hooks.post("/triggers/:triggerId", capBody, async (c) => {
  const triggerId = c.req.param("triggerId");
  try {
    return await fire(c, triggerId);
  } catch (error) {
    // why: every path in `fire` logs as it returns, so a throw means no line was written yet
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
