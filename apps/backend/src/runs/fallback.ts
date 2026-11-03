import {
  APICallError,
  InvalidToolInputError,
  NoSuchToolError,
  RetryError,
  type AssistantContent,
  type ModelMessage,
  type ToolContent,
  type ToolResultPart,
} from "ai";
import { isContextOverflowError } from "../services/context-overflow.ts";

/**
 * The Fallback model's two pure rules (ADR-0043): when a failure is the
 * Provider's to own, and what of a Transcript may cross to another Provider.
 *
 * Both are stated here rather than inside the Drive because each is a decision
 * with a durable consequence: switching on the wrong error hides a configuration
 * fault and bills for it twice, and carrying vendor-only data across the switch
 * makes the fallback reject a Transcript its own Provider never wrote.
 */

/**
 * How many times the SDK may retry the primary before a run with a Fallback
 * model switches (ADR-0043): one retry, two attempts in total. A run without a
 * fallback keeps the SDK's default.
 */
export const FALLBACK_SDK_RETRIES = 1;

/**
 * Whether a failure means "this Provider cannot serve the request", which is
 * the only class a Fallback model may answer (ADR-0043): unreachable, timed
 * out, rate limited (429), their side failing (5xx), credentials refused
 * (401/403), or still failing after the SDK's retries.
 *
 * Never: a 400/413/422 the Provider rejected as invalid, a refused Tool input
 * or unknown tool, context overflow (which keeps its own recovery path), or an
 * abort. Those are faults in how the Agent is set up or a stop the caller
 * asked for, and another Provider would hide the fault or ignore the stop.
 *
 * `RetryError` is judged by what it wrapped: the SDK only retries an error it
 * considers transient, so anything it wrapped and still failed on qualifies
 * unless it is one of the explicitly non-switching classes above.
 */
export const isProviderUnavailableError = (error: unknown): boolean => {
  if (error === null || error === undefined) return false;
  if (isContextOverflowError(error)) return false;

  if (RetryError.isInstance(error)) {
    return !isRequestFault(error.lastError);
  }
  if (isRequestFault(error)) return false;

  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    if (status === 408 || status === 429) return true;
    if (status === 401 || status === 403) return true;
    if (status != null && status >= 500) return true;
    // A fetch that never reached the Provider carries no status; the SDK marks
    // it retryable, which is what separates it from a 400.
    return status == null && error.isRetryable === true;
  }

  if (error instanceof Error) {
    if (error.name === "AbortError") return false;
    if (error.name === "TimeoutError") return true;
    // `fetch` reports a connection failure as a TypeError ("fetch failed").
    if (
      error.name === "TypeError" &&
      /fetch failed|network/i.test(error.message)
    )
      return true;
    return false;
  }

  // The stream stringifies some failures before a Drive sees them; recognise
  // the sentences `describeSdkError` produces for the switchable classes.
  if (typeof error === "string") {
    return /rate limit|currently unavailable|authentication failed|timed out|fetch failed/i.test(
      error,
    );
  }
  return false;
};

/** The Provider rejected the request itself — another one would repeat it. */
const isRequestFault = (error: unknown): boolean => {
  if (isContextOverflowError(error)) return true;
  if (InvalidToolInputError.isInstance(error)) return true;
  if (NoSuchToolError.isInstance(error)) return true;
  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    return status === 400 || status === 413 || status === 422;
  }
  return false;
};

/**
 * Drops the vendor-only parts of a Transcript before another Provider sees it
 * (ADR-0043).
 *
 * Reasoning parts (and their signatures, encrypted blobs and provider options)
 * belong to the model that produced them and are rejected by a different
 * vendor. So do request-level vendor options such as cache markers. Text, tool
 * calls and tool results are kept.
 *
 * A tool the primary Provider ran itself has no counterpart on the fallback,
 * so its call is dropped and its result becomes plain text — the finding
 * survives without asking the new Provider to answer a call it never made.
 */
export const sanitizeMessagesForFallback = (
  messages: ModelMessage[],
): ModelMessage[] =>
  messages.flatMap((message) => {
    const cleaned = sanitizeMessage(message);
    return cleaned === null ? [] : [cleaned];
  });

const sanitizeMessage = (message: ModelMessage): ModelMessage | null => {
  switch (message.role) {
    case "system": {
      const { providerOptions: _omit, ...rest } = message;
      return rest;
    }
    case "user": {
      const { providerOptions: _omit, ...rest } = message;
      if (typeof message.content === "string") return rest;
      return {
        ...rest,
        content: message.content.map((part) => stripOptions(part)),
      };
    }
    case "assistant": {
      const { providerOptions: _omit, ...rest } = message;
      if (typeof message.content === "string") return rest;
      const content = message.content.flatMap(sanitizeAssistantPart);
      // A step that produced nothing but reasoning leaves no message behind:
      // an empty content array is not a shape any Provider accepts.
      return content.length === 0 ? null : { ...rest, content };
    }
    case "tool": {
      const { providerOptions: _omit, ...rest } = message;
      return {
        ...rest,
        content: message.content.map(sanitizeToolPart),
      };
    }
    default:
      return null;
  }
};

const stripOptions = <T>(value: T): T => {
  if (typeof value !== "object" || value === null) return value;
  if (
    !("providerOptions" in value) ||
    (value as { providerOptions?: unknown }).providerOptions === undefined
  ) {
    return value;
  }
  const { providerOptions: _omit, ...rest } = value as T & {
    providerOptions?: unknown;
  };
  return rest as T;
};

type AssistantPart = Exclude<AssistantContent, string>[number];
type ToolPart = ToolContent[number];

const sanitizeAssistantPart = (part: AssistantPart): AssistantPart[] => {
  switch (part.type) {
    case "reasoning":
    case "reasoning-file":
      return [];
    case "tool-call":
      // Provider-executed calls are the Provider's own; the result below
      // carries what they found.
      return part.providerExecuted ? [] : [stripOptions(part)];
    case "tool-result":
      return [
        {
          type: "text",
          text: `Tool "${part.toolName}" returned: ${renderToolOutput(part.output)}`,
        },
      ];
    case "text":
    case "file":
    case "custom":
      return [stripOptions(part)];
    default:
      return [];
  }
};

const sanitizeToolPart = (part: ToolPart): ToolPart => {
  // An approval response carries no provider options of its own.
  if (part.type === "tool-approval-response") return part;
  const stripped = stripOptions(part);
  return { ...stripped, output: stripOptions(stripped.output) };
};

/** A tool result as text a different Provider can read. */
const renderToolOutput = (output: ToolResultPart["output"]): string => {
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value;
    case "json":
    case "error-json":
      return JSON.stringify(output.value);
    case "execution-denied":
      return output.reason ?? "The call was denied.";
    case "content": {
      // The content shape mixes text with file parts; only text survives as
      // plain text, and a file part carries nothing a different Provider can
      // read here.
      const parts: ReadonlyArray<{ type: string; text?: string }> =
        output.value;
      return parts
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .filter((text) => text !== "")
        .join("\n");
    }
    default:
      return JSON.stringify(output);
  }
};
