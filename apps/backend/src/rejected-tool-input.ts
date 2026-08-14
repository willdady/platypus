/**
 * What the model actually emitted for a tool call that failed.
 *
 * Two different failures reach production with the same symptom (issue #406):
 * arguments cut off mid-JSON, and an `AI_InvalidToolInputError` whose value is
 * an empty object. Neither is distinguishable from the outside, because the SDK
 * validates an *empty* argument string against the schema as `{}` — so
 * `Value: {}` in a log means either "the model emitted `{}`" or "the model
 * emitted nothing at all".
 *
 * The SDK itself carries the discriminator. When a tool call fails to parse it
 * builds `input = parsedInput.success ? parsedInput.value : toolCall.input`, so
 * unparseable JSON leaves the raw string in place while a parsed-but-rejected
 * value arrives as the parsed object. Reading the runtime type of `input`
 * classifies the failure without having to read the payload itself.
 *
 * Everything here is capped before it reaches the logger: this is a plain field
 * rather than an error, so the error serializer never sees it, and tool
 * arguments are model and user data that may carry secrets (issue #414).
 */

import { omitted, safeStringify } from "./log-serializers.ts";
import { truncate } from "./zod-issues.ts";

/**
 * How much of the rejected payload is worth keeping.
 *
 * Enough to see whether a JSON string stops mid-value, and no more: past this
 * the record is carrying the arguments rather than describing them. Matches the
 * property cap the log serializer already applies.
 */
export const MAX_TOOL_INPUT_PREFIX = 512;

/** The `tool-error` part, structurally — both stream parts and step content. */
export type ToolErrorLike = {
  type?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  input?: unknown;
};

/**
 * How the payload arrived, stated outright so nobody has to infer it from the
 * prefix:
 *
 * - `unparseable` — a non-empty raw string the SDK could not parse as JSON,
 *   which is the truncated-mid-generation signature
 * - `empty` — the model emitted no arguments at all
 * - `parsed` — valid JSON the tool's schema (or its execution) then rejected
 * - `unserializable` — a parsed value that cannot be rendered as text
 * - `absent` — no input on the part at all (a provider-executed result)
 */
export type ToolInputKind =
  "unparseable" | "empty" | "parsed" | "unserializable" | "absent";

export type ToolInputRecord = {
  toolCallId?: string;
  toolName?: string;
  /** The runtime type as seen, including `null` and `array`. */
  inputType: string;
  inputKind: ToolInputKind;
  /**
   * Characters, so the number and the cap share a unit.
   *
   * On a `parsed` value this measures the re-serialized JSON, not the text the
   * model emitted — the SDK keeps no copy of that once it has parsed it. Only
   * an `unparseable` length can be held against a suspected output ceiling.
   */
  inputLength?: number;
  inputPrefix?: string;
  /** Present only when the prefix was cut; a cut is never silent. */
  omitted?: string;
};

/** `typeof`, minus the two answers it gets uselessly wrong. */
const runtimeType = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** The length, a capped prefix, and what the cap removed. */
const payload = (text: string): Partial<ToolInputRecord> => {
  const prefix = truncate(text, MAX_TOOL_INPUT_PREFIX);
  if (prefix === text) return { inputLength: text.length, inputPrefix: prefix };
  return {
    inputLength: text.length,
    inputPrefix: prefix,
    // Counted off the prefix rather than the cap so the two can't drift apart.
    // `truncate` ends on an ellipsis, which stands in for one character more
    // than the tail it replaced.
    omitted: omitted(text.length - (prefix.length - 1)),
  };
};

/**
 * Describe one failed tool call's arguments.
 *
 * Never throws: an input it doesn't recognise still produces a record naming
 * the runtime type it saw, because this is coupled to SDK internals and logging
 * nothing is the one outcome that leaves the original question unanswered.
 */
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

  // Anything else came back from `JSON.parse`, including a bare number or null:
  // valid JSON the schema went on to reject.
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

/**
 * Pick the failed tool calls out of a finished step's content.
 *
 * Every `tool-error` part is described, not just the ones whose error text
 * matches an invalid-input message. Gating on the error's shape would couple a
 * *decision* to the SDK's message format, and the failure mode of that coupling
 * drifting is silence — which is exactly the state this record exists to end.
 * A `tool-error` is never the success path, so nothing here can fire for a tool
 * call that worked.
 */
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
