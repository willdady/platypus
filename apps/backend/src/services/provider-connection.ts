import { APICallError, generateText, RetryError } from "ai";
import {
  SESSION_ID_HEADER_PLACEHOLDER,
  type ProviderTest,
  type ProviderTestFailureClass,
  type ProviderTestResponse,
} from "@platypus/schemas";
import { openProvider } from "./provider.ts";
import { resolveModelId } from "./model-capability.ts";
import { DeadlineExceededError, withDeadline } from "../utils/abort-race.ts";
import { ValidationError } from "../errors.ts";

const PROVIDER_TEST_SESSION_ID = "provider-connection-test";

const PROVIDER_TEST_TIMEOUT_MS = 20_000;

const PROVIDER_TEST_MAX_OUTPUT_TOKENS = 16;

const PROVIDER_TEST_PROMPT = "Reply with the single word ok.";

const MODEL_NOT_FOUND_MESSAGE =
  /model_not_found|\bmodel\b[^.\n]{0,120}\bnot found\b|no such model|unknown model|\bmodel\b[^.\n]{0,120}\bdoes not exist\b/i;

const CONNECTION_ERROR_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

const isConnectionFailure = (error: unknown): boolean => {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const { code } = current as { code?: unknown };
    if (typeof code === "string" && CONNECTION_ERROR_CODES.has(code)) {
      return true;
    }
    current = current.cause;
  }
  return false;
};

const failedAttempt = (error: unknown): unknown =>
  RetryError.isInstance(error) ? error.lastError : error;

const classifyProviderTestFailure = (
  error: unknown,
): ProviderTestFailureClass => {
  const failure = failedAttempt(error);

  if (APICallError.isInstance(failure)) {
    const { message, statusCode } = failure;
    if (statusCode === 401 || statusCode === 403) return "api-key-rejected";
    if (statusCode === 429) return "rate-limited";
    if (statusCode === 404) return "model-not-available";
    if (MODEL_NOT_FOUND_MESSAGE.test(message)) return "model-not-available";
    if (statusCode === 400 && /responses/i.test(message)) {
      return "api-mode-wrong";
    }
    if (statusCode == null) return "base-url-unreachable";
    return "unknown";
  }

  if (failure instanceof DeadlineExceededError) return "base-url-unreachable";
  if (failure instanceof Error) {
    if (failure.name === "TimeoutError") return "base-url-unreachable";
    if (isConnectionFailure(failure)) return "base-url-unreachable";
    if (
      failure.name === "TypeError" &&
      /fetch failed|network|socket/i.test(failure.message)
    ) {
      return "base-url-unreachable";
    }
  }

  return "unknown";
};

const providerMessage = (error: unknown): string => {
  const failure = failedAttempt(error);
  if (failure instanceof Error) return failure.message;
  if (typeof failure === "string") return failure;
  return "Unknown error connecting to the Provider";
};

const substitutesSessionId = (headers: ProviderTest["headers"]): boolean =>
  Object.values(headers ?? {}).some(
    (value) =>
      typeof value === "string" &&
      value.includes(SESSION_ID_HEADER_PLACEHOLDER),
  );

export const probeProviderConnection = async (
  data: ProviderTest,
): Promise<ProviderTestResponse> => {
  const { modelId } = data;
  const sessionIdSubstituted = substitutesSessionId(data.headers);

  const concreteModelId = resolveModelId({ modelIds: data.modelIds }, modelId);
  if (!concreteModelId) {
    throw new ValidationError(
      `Model "${modelId}" is not one of this Provider's models.`,
    );
  }

  const connection = {
    name: data.name ?? "Provider test",
    providerType: data.providerType,
    apiKey: data.apiKey,
    apiMode: data.apiMode,
    region: data.region ?? null,
    baseUrl: data.baseUrl ?? null,
    headers: data.headers ?? null,
    extraBody: data.extraBody ?? null,
    organization: data.organization ?? null,
    project: data.project ?? null,
  };

  try {
    await withDeadline(
      (abortSignal) =>
        generateText({
          model: openProvider(connection, {
            sessionId: PROVIDER_TEST_SESSION_ID,
          }).languageModel(concreteModelId),
          prompt: PROVIDER_TEST_PROMPT,
          temperature: 0,
          maxOutputTokens: PROVIDER_TEST_MAX_OUTPUT_TOKENS,
          // why: one attempt; a retry only slows reporting a bad key or URL
          maxRetries: 0,
          abortSignal,
        }),
      PROVIDER_TEST_TIMEOUT_MS,
    );
    return { success: true, modelId, sessionIdSubstituted };
  } catch (error) {
    return {
      success: false,
      modelId,
      failureClass: classifyProviderTestFailure(error),
      message: providerMessage(error),
      sessionIdSubstituted,
    };
  }
};
