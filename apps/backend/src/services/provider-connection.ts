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

/**
 * The Provider-connection probe both `/providers/test` routes delegate to, the
 * way `probeMcpConnection` serves the two MCP surfaces. It takes a config, not
 * a stored id: the form tests its current, unsaved values, and a blank key or
 * header means the operator cleared it rather than "use the saved one".
 *
 * The probe is one tiny real completion through `openProvider`, exactly as a
 * turn opens it, so a success says the whole path works — credentials, base
 * URL, API mode and model id. Nothing is stored. A failure is returned as a
 * class plus the vendor's own message, not thrown: the form needs to render it
 * on the card that was tested.
 */

/**
 * The session id a test substitutes for `${SESSION_ID}`. Fixed rather than a
 * real Chat or Trigger run id because nothing is stored and no Chat is
 * involved; it is recognisable in a vendor's request log as a test.
 */
const PROVIDER_TEST_SESSION_ID = "provider-connection-test";

/** Bounds the probe, so a server that accepts the connection and never answers is reported, not waited on. */
const PROVIDER_TEST_TIMEOUT_MS = 20_000;

/** A one-word reply needs no more; a model that ignores the prompt is still cut here. */
const PROVIDER_TEST_MAX_OUTPUT_TOKENS = 16;

const PROVIDER_TEST_PROMPT = "Reply with the single word ok.";

/** The vendor's own "there is no such model here" wording, across vendors. */
const MODEL_NOT_FOUND_MESSAGE =
  /model_not_found|\bmodel\b[^.\n]{0,120}\bnot found\b|no such model|unknown model|\bmodel\b[^.\n]{0,120}\bdoes not exist\b/i;

/**
 * Whether a caught error is a failure to reach the server at all — DNS, TLS,
 * a refused connection, or a timeout. The details live on the `cause` chain
 * (`fetch` reports the outer failure as a bare `TypeError`), so the walk goes
 * looking for the libuv/undici code rather than trusting the message alone.
 */
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

/**
 * The error the last attempt hit. The SDK wraps a failure that outlived its
 * retries in `RetryError`; the class and the message both describe the inner
 * one.
 */
const failedAttempt = (error: unknown): unknown =>
  RetryError.isInstance(error) ? error.lastError : error;

/**
 * The class a failed probe is reported as. The AI SDK throws `APICallError`
 * for a response with a status, and a transport failure as whatever `fetch`
 * threw.
 */
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
    // An OpenAI-compatible server that has no Responses API rejects the route
    // with a 400 naming it — the common cause of a vLLM/Ollama Provider that
    // saves fine and fails every turn.
    if (statusCode === 400 && /responses/i.test(message)) {
      return "api-mode-wrong";
    }
    // No status means the SDK never got a response: the connection itself
    // failed rather than the request being rejected.
    if (statusCode == null) return "base-url-unreachable";
    return "unknown";
  }

  if (failure instanceof DeadlineExceededError) return "base-url-unreachable";
  if (failure instanceof Error) {
    if (failure.name === "TimeoutError") return "base-url-unreachable";
    if (isConnectionFailure(failure)) return "base-url-unreachable";
    // `fetch` reports a connection failure as a bare TypeError.
    if (
      failure.name === "TypeError" &&
      /fetch failed|network|socket/i.test(failure.message)
    ) {
      return "base-url-unreachable";
    }
  }

  return "unknown";
};

/** The Provider's own words, verbatim, for the inline alert. */
const providerMessage = (error: unknown): string => {
  const failure = failedAttempt(error);
  if (failure instanceof Error) return failure.message;
  if (typeof failure === "string") return failure;
  return "Unknown error connecting to the Provider";
};

/** Whether any custom header value carries the session placeholder to replace. */
const substitutesSessionId = (headers: ProviderTest["headers"]): boolean =>
  Object.values(headers ?? {}).some(
    (value) =>
      typeof value === "string" &&
      value.includes(SESSION_ID_HEADER_PLACEHOLDER),
  );

/**
 * Probes one of a Provider's models with the form's current values and reports
 * success, or a failure class together with the vendor's message. The model is
 * resolved through the Provider's own model list, exactly as a turn resolves
 * it, so an alias works.
 */
export const probeProviderConnection = async (
  data: ProviderTest,
): Promise<ProviderTestResponse> => {
  const { modelId } = data;
  const sessionIdSubstituted = substitutesSessionId(data.headers);

  const concreteModelId = resolveModelId({ modelIds: data.modelIds }, modelId);
  if (!concreteModelId) {
    // Unreachable from the form, which only sends a card's own id. It is a
    // malformed request, not a Provider result: nothing was sent, so there is
    // no vendor message to report and none is invented.
    throw new ValidationError(
      `Model "${modelId}" is not one of this Provider's models.`,
    );
  }

  // A half-filled form can test before it has a Name, which only names the
  // vendor client in-process; the create rule still applies when one is sent.
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
          // One attempt: the form already shows the failure and inviting a
          // retry only makes a bad key or URL slower to report.
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
