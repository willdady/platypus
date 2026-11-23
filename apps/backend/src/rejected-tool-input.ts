import { omitted, safeStringify } from "./log-serializers.ts";
import { truncate } from "./zod-issues.ts";

export const MAX_TOOL_INPUT_PREFIX = 512;

export type ToolErrorLike = {
  type?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  input?: unknown;
};

type ToolInputKind =
  "unparseable" | "empty" | "parsed" | "unserializable" | "absent";

export type ToolInputRecord = {
  toolCallId?: string;
  toolName?: string;
  inputType: string;
  inputKind: ToolInputKind;
  inputLength?: number;
  inputPrefix?: string;
  omitted?: string;
};

const runtimeType = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const payload = (text: string): Partial<ToolInputRecord> => {
  const prefix = truncate(text, MAX_TOOL_INPUT_PREFIX);
  if (prefix === text) return { inputLength: text.length, inputPrefix: prefix };
  return {
    inputLength: text.length,
    inputPrefix: prefix,
    omitted: omitted(text.length - (prefix.length - 1)),
  };
};

export const describeToolInput = (part: ToolErrorLike): ToolInputRecord => {
  const record: ToolInputRecord = {
    inputType: runtimeType(part.input),
    inputKind: "absent",
  };
  const toolCallId = asString(part.toolCallId);
  const toolName = asString(part.toolName);
  if (toolCallId !== undefined) record.toolCallId = toolCallId;
  if (toolName !== undefined) record.toolName = toolName;

  if (part.input === undefined) return record;

  if (typeof part.input === "string") {
    return {
      ...record,
      inputKind: part.input.length === 0 ? "empty" : "unparseable",
      ...payload(part.input),
    };
  }

  const text = safeStringify(part.input);
  if (text === undefined) {
    return {
      ...record,
      inputKind: "unserializable",
      inputPrefix: "[unserializable]",
    };
  }
  return { ...record, inputKind: "parsed", ...payload(text) };
};

export const rejectedToolInputs = (content: unknown): ToolInputRecord[] => {
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (part): part is ToolErrorLike =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "tool-error",
    )
    .map(describeToolInput);
};
