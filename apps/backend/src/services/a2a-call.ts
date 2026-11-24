import { A2A_ERROR_CODE } from "@a2a-js/sdk/errors";
import { logger } from "../logger.ts";
import { readPositiveInt } from "./trigger-breaker.ts";
import { isRecord } from "../utils/is-record.ts";

export type A2aSettings = {
  maxConcurrentRuns: number;
  maxConcurrentStreams: number;
  maxBodyBytes: number;
};

const DEFAULT_A2A_MAX_CONCURRENT_RUNS = 10;
const DEFAULT_A2A_MAX_CONCURRENT_STREAMS = 100;
const DEFAULT_A2A_MAX_BODY_BYTES = 1048576;

export const a2aSettings = (): A2aSettings => ({
  maxConcurrentRuns: readPositiveInt(
    "A2A_MAX_CONCURRENT_RUNS",
    DEFAULT_A2A_MAX_CONCURRENT_RUNS,
    process.env,
  ),
  maxConcurrentStreams: readPositiveInt(
    "A2A_MAX_CONCURRENT_STREAMS",
    DEFAULT_A2A_MAX_CONCURRENT_STREAMS,
    process.env,
  ),
  maxBodyBytes: readPositiveInt(
    "A2A_MAX_BODY_BYTES",
    DEFAULT_A2A_MAX_BODY_BYTES,
    process.env,
  ),
});

export const validateA2aSettings = (): A2aSettings => {
  const settings = a2aSettings();
  logger.info(settings, "A2A configured");
  return settings;
};

export const A2A_RETRY_AFTER_SECONDS = 30;

export class A2aAtCapacityError extends Error {
  constructor(message = "Too many A2A runs are active") {
    super(message);
    this.name = "A2aAtCapacityError";
  }
}

const heldSlots = new Set<symbol>();

export const acquireA2aRunSlot = (): (() => void) | null => {
  // why: no await between the cap check and the add, or concurrent calls all pass it
  if (heldSlots.size >= a2aSettings().maxConcurrentRuns) return null;
  const slot = Symbol("a2a-run");
  heldSlots.add(slot);
  return () => void heldSlots.delete(slot);
};

export const A2A_MAX_STREAMS_PER_TOKEN = 10;

const heldFollowers = new Map<symbol, string>();
const followersByToken = new Map<string, number>();

export const acquireA2aFollowerSlot = (
  tokenId: string,
): (() => void) | null => {
  const max = a2aSettings().maxConcurrentStreams;
  const held = followersByToken.get(tokenId) ?? 0;
  if (
    heldFollowers.size >= max ||
    held >= Math.min(A2A_MAX_STREAMS_PER_TOKEN, max)
  ) {
    return null;
  }
  const slot = Symbol("a2a-follower");
  heldFollowers.set(slot, tokenId);
  followersByToken.set(tokenId, held + 1);
  return () => {
    if (!heldFollowers.delete(slot)) return;
    const left = (followersByToken.get(tokenId) ?? 1) - 1;
    if (left > 0) followersByToken.set(tokenId, left);
    else followersByToken.delete(tokenId);
  };
};

export type A2aCallOutcome = "ok" | "rejected" | "rate_limited";

export type A2aRejectReason =
  | "unknown_endpoint"
  | "disabled"
  | "gate"
  | "owner_left"
  | "missing_token"
  | "bad_token"
  | "expired_token"
  | "body_too_large"
  | "busy"
  | "notification"
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
  | "a2a_error"
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

export const reasonOfRpcCode = (code: number): A2aRejectReason =>
  REASON_OF_CODE[code] ?? "a2a_error";

export const AGENT_CARD_METHOD = "GetAgentCard";

export const rpcMethodOf = (request: unknown): string | null => {
  const method = isRecord(request) ? request.method : undefined;
  // why: the caller picks the method, so only a plain name may reach the log
  return typeof method === "string" && /^[A-Za-z]{1,64}$/.test(method)
    ? method
    : null;
};

const isRpcId = (id: unknown): id is string | number =>
  typeof id === "string" || (typeof id === "number" && Number.isInteger(id));

export type RpcEnvelope =
  | {
      kind: "request";
      request: Record<string, unknown>;
      id: string | number;
      method: string | null;
      nullDataParts: ReadonlySet<number>;
    }
  | { kind: "notification"; method: string | null }
  | {
      kind: "malformed";
      id: string | number | null;
      method: string | null;
      error: { code: number; message: string };
    };

const nullDataPartsOf = (request: Record<string, unknown>): Set<number> => {
  const params = request.params as { message?: { parts?: unknown } } | null;
  const parts = params?.message?.parts;
  const indexes = new Set<number>();
  if (!Array.isArray(parts)) return indexes;
  parts.forEach((part: unknown, index) => {
    if (
      typeof part === "object" &&
      part !== null &&
      "data" in part &&
      part.data === null
    ) {
      indexes.add(index);
    }
  });
  return indexes;
};

export const readRpcEnvelope = (body: string): RpcEnvelope => {
  let request: unknown;
  try {
    request = JSON.parse(body);
  } catch {
    return {
      kind: "malformed",
      id: null,
      method: null,
      error: { code: A2A_ERROR_CODE.PARSE_ERROR, message: "Parse error" },
    };
  }
  if (Array.isArray(request)) {
    return {
      kind: "malformed",
      id: null,
      method: null,
      error: {
        code: A2A_ERROR_CODE.INVALID_REQUEST,
        message: "Batch requests are not supported",
      },
    };
  }
  const method = rpcMethodOf(request);
  const fields =
    typeof request === "object" && request !== null
      ? (request as Record<string, unknown>)
      : undefined;
  const id = fields && isRpcId(fields.id) ? fields.id : null;
  if (
    !fields ||
    fields.jsonrpc !== "2.0" ||
    typeof fields.method !== "string" ||
    ("id" in fields && !isRpcId(fields.id))
  ) {
    return {
      kind: "malformed",
      id,
      method,
      error: {
        code: A2A_ERROR_CODE.INVALID_REQUEST,
        message: "Invalid Request",
      },
    };
  }
  if (id === null) return { kind: "notification", method };
  return {
    kind: "request",
    request: fields,
    id,
    method,
    nullDataParts: nullDataPartsOf(fields),
  };
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

export const A2A_CALL_LOG_MESSAGE = "A2A call";

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
