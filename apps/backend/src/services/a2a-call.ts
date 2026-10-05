import { A2A_ERROR_CODE } from "@a2a-js/sdk/errors";
import { logger } from "../logger.ts";
import { readPositiveInt } from "./trigger-breaker.ts";

/**
 * What bounds and records outside calls to A2A endpoints (ADR-0032): the
 * server-wide cap on active A2A runs, and the one log line every call writes.
 * The route maps these onto status codes; the turn path takes the slots.
 */

// ----------------------------------------------------------------- settings

export type A2aSettings = {
  /** A2A runs this backend instance will have active at once. */
  maxConcurrentRuns: number;
};

export const a2aSettings = (
  env: NodeJS.ProcessEnv = process.env,
): A2aSettings => ({
  maxConcurrentRuns: readPositiveInt("A2A_MAX_CONCURRENT_RUNS", 10, env),
});

/**
 * Validates the settings and reports them at boot, so a malformed value fails
 * the deployment instead of being replaced by a default nobody chose.
 */
export const validateA2aSettings = (): A2aSettings => {
  const settings = a2aSettings();
  logger.info(settings, "A2A configured");
  return settings;
};

/** Seconds a caller over the cap is told to wait. */
export const A2A_RETRY_AFTER_SECONDS = 30;

// ----------------------------------------------------------------- load cap

/** A turn refused because the cap is reached. Nothing has been written. */
export class A2aAtCapacityError extends Error {
  constructor() {
    super("Too many A2A runs are active");
    this.name = "A2aAtCapacityError";
  }
}

/**
 * The slots of active A2A runs, held in this process: a run executes in the
 * process that started it, so this is the count that bounds this process's
 * load. Taking a slot is synchronous, so concurrent calls cannot all pass a
 * check that none has yet acted on.
 */
const heldSlots = new Set<symbol>();

/**
 * Takes a slot for a turn about to start, or `null` past the cap. The release
 * it returns gives that slot back, once however often it is called, so the
 * run ending and the start failing can both call it.
 */
export const acquireA2aRunSlot = (
  max: number = a2aSettings().maxConcurrentRuns,
): (() => void) | null => {
  if (heldSlots.size >= max) return null;
  const slot = Symbol("a2a-run");
  heldSlots.add(slot);
  return () => void heldSlots.delete(slot);
};

/** Test seam: the count of slots currently held. */
export const activeA2aRunCount = (): number => heldSlots.size;

/** Test seam: forget every held slot. */
export const resetA2aRunSlots = (): void => heldSlots.clear();

// ----------------------------------------------------------------- call log

/** What happened to one call. */
export type A2aCallOutcome = "ok" | "rejected" | "rate_limited";

/** Why a call was rejected. Only the log says; the caller sees the answer. */
export type A2aRejectReason =
  | "unknown_endpoint"
  | "disabled"
  | "gate"
  | "owner_left"
  | "missing_token"
  | "bad_token"
  | "expired_token"
  /** The Chat already has a run going. */
  | "busy"
  | "parse_error"
  | "invalid_request"
  | "method_not_found"
  | "invalid_params"
  | "task_not_found"
  | "task_not_cancelable"
  | "push_notification_not_supported"
  | "unsupported_operation"
  | "content_type_not_supported"
  | "version_not_supported"
  /** Any other A2A error. */
  | "a2a_error"
  /** The backend failed while handling the call. */
  | "internal_error";

const REASON_OF_CODE: Record<number, A2aRejectReason> = {
  [A2A_ERROR_CODE.PARSE_ERROR]: "parse_error",
  [A2A_ERROR_CODE.INVALID_REQUEST]: "invalid_request",
  [A2A_ERROR_CODE.METHOD_NOT_FOUND]: "method_not_found",
  [A2A_ERROR_CODE.INVALID_PARAMS]: "invalid_params",
  [A2A_ERROR_CODE.INTERNAL_ERROR]: "internal_error",
  [A2A_ERROR_CODE.TASK_NOT_FOUND]: "task_not_found",
  [A2A_ERROR_CODE.TASK_NOT_CANCELABLE]: "task_not_cancelable",
  [A2A_ERROR_CODE.PUSH_NOTIFICATION_NOT_SUPPORTED]:
    "push_notification_not_supported",
  [A2A_ERROR_CODE.UNSUPPORTED_OPERATION]: "unsupported_operation",
  [A2A_ERROR_CODE.CONTENT_TYPE_NOT_SUPPORTED]: "content_type_not_supported",
  [A2A_ERROR_CODE.VERSION_NOT_SUPPORTED]: "version_not_supported",
};

/** The reason a JSON-RPC error code is logged with. */
export const reasonOfRpcCode = (code: number): A2aRejectReason =>
  REASON_OF_CODE[code] ?? "a2a_error";

/** The method a card fetch is logged under; JSON-RPC calls log their own. */
export const AGENT_CARD_METHOD = "GetAgentCard";

/**
 * The method a JSON-RPC body names, or `null`. The caller chose it, so only a
 * plain name is logged.
 */
export const rpcMethodOf = (body: string): string | null => {
  try {
    const method: unknown = (JSON.parse(body) as { method?: unknown })?.method;
    return typeof method === "string" && /^[A-Za-z]{1,64}$/.test(method)
      ? method
      : null;
  } catch {
    return null;
  }
};

export type A2aCallLogEntry = {
  endpointId: string;
  organizationId?: string;
  workspaceId?: string;
  tokenId?: string;
  method?: string | null;
  outcome: A2aCallOutcome;
  reason?: A2aRejectReason;
  taskId?: string;
  chatId?: string;
};

/** The call log line's message. Documented, and so not to be changed. */
export const A2A_CALL_LOG_MESSAGE = "A2A call";

/**
 * The one line every call to an endpoint writes, the card included, whatever
 * its outcome. Its message, fields and values are a documented format an
 * Operator's log tooling relies on: every field is present on every line,
 * `null` where it does not apply. Never any message content.
 */
export const logA2aCall = (entry: A2aCallLogEntry): void => {
  logger.info(
    {
      organizationId: entry.organizationId ?? null,
      workspaceId: entry.workspaceId ?? null,
      endpointId: entry.endpointId,
      tokenId: entry.tokenId ?? null,
      method: entry.method ?? null,
      outcome: entry.outcome,
      reason: entry.reason ?? null,
      taskId: entry.taskId ?? null,
      chatId: entry.chatId ?? null,
    },
    A2A_CALL_LOG_MESSAGE,
  );
};
