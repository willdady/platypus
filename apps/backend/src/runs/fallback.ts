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

export const FALLBACK_SDK_RETRIES = 1;

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
    return status == null && error.isRetryable === true;
  }

  if (error instanceof Error) {
    if (error.name === "AbortError") return false;
    if (error.name === "TimeoutError") return true;
    if (
      error.name === "TypeError" &&
      /fetch failed|network/i.test(error.message)
    )
      return true;
    return false;
  }

  if (typeof error === "string") {
    return /rate limit|currently unavailable|authentication failed|timed out|fetch failed/i.test(
      error,
    );
  }
  return false;
};

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
  if (part.type === "tool-approval-response") return part;
  const stripped = stripOptions(part);
  return { ...stripped, output: stripOptions(stripped.output) };
};

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
