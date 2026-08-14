import { describe, it, expect } from "vitest";
import {
  describeToolInput,
  MAX_TOOL_INPUT_PREFIX,
  rejectedToolInputs,
} from "./rejected-tool-input.ts";

describe("describeToolInput", () => {
  it("identifies a payload the SDK could not parse as JSON", () => {
    // Signature A from issue #406: generation stopped mid-string, so the SDK
    // left the raw text in place instead of a parsed value.
    const raw = '{"path":"notes/todo.md","body":"the first half of a very lon';

    expect(
      describeToolInput({
        type: "tool-error",
        toolCallId: "call_1",
        toolName: "writeFile",
        input: raw,
      }),
    ).toEqual({
      toolCallId: "call_1",
      toolName: "writeFile",
      inputType: "string",
      inputKind: "unparseable",
      inputLength: raw.length,
      inputPrefix: raw,
    });
  });

  it("tells an empty argument string apart from a literal empty object", () => {
    // The SDK validates an empty argument string as `{}`, so both land in the
    // production logs as `Value: {}` — the ambiguity this record exists to end.
    const emitted = describeToolInput({ input: "" });
    const literal = describeToolInput({ input: {} });

    expect(emitted).toMatchObject({
      inputType: "string",
      inputKind: "empty",
      inputLength: 0,
    });
    expect(literal).toMatchObject({
      inputType: "object",
      inputKind: "parsed",
      inputLength: 2,
      inputPrefix: "{}",
    });
  });

  it("identifies a payload that parsed but failed the schema", () => {
    expect(
      describeToolInput({ input: { title: "a", body: 12 } }),
    ).toMatchObject({
      inputType: "object",
      inputKind: "parsed",
      inputPrefix: '{"title":"a","body":12}',
    });
  });

  it("classifies a parsed non-object JSON value by the type it saw", () => {
    // `123` is valid JSON, so the SDK hands back a number the schema rejects.
    expect(describeToolInput({ input: 123 })).toMatchObject({
      inputType: "number",
      inputKind: "parsed",
      inputPrefix: "123",
    });
    expect(describeToolInput({ input: null })).toMatchObject({
      inputType: "null",
      inputKind: "parsed",
    });
    expect(describeToolInput({ input: [1, 2] })).toMatchObject({
      inputType: "array",
      inputKind: "parsed",
    });
  });

  it("records an absent input rather than inventing one", () => {
    expect(describeToolInput({ input: undefined })).toMatchObject({
      inputType: "undefined",
      inputKind: "absent",
    });
  });

  it("caps the prefix and says how much it cut", () => {
    const raw = "x".repeat(MAX_TOOL_INPUT_PREFIX + 40);
    const record = describeToolInput({ input: raw });

    expect(record.inputLength).toBe(MAX_TOOL_INPUT_PREFIX + 40);
    expect(record.inputPrefix?.length).toBe(MAX_TOOL_INPUT_PREFIX);
    // A silently shortened diagnostic is worse than none. 41, not 40: the
    // ellipsis the cap leaves behind occupies one of the kept characters.
    expect(record.omitted).toBe("[omitted: 41 characters]");
  });

  it("leaves a payload that fits uncut and unmarked", () => {
    const record = describeToolInput({ input: "x".repeat(20) });

    expect(record.inputPrefix).toBe("x".repeat(20));
    expect(record.omitted).toBeUndefined();
  });

  it("records an unserializable input instead of throwing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(describeToolInput({ input: circular })).toMatchObject({
      inputType: "object",
      inputKind: "unserializable",
      inputPrefix: "[unserializable]",
    });
    expect(describeToolInput({ input: { big: 1n } })).toMatchObject({
      inputKind: "unserializable",
    });
  });
});

describe("rejectedToolInputs", () => {
  it("describes every failed tool call in a finished step", () => {
    const records = rejectedToolInputs([
      { type: "text", text: "here goes" },
      { type: "tool-call", toolCallId: "call_1", toolName: "writeFile" },
      {
        type: "tool-error",
        toolCallId: "call_1",
        toolName: "writeFile",
        input: '{"body":"cut',
        error: "AI_InvalidToolInputError: Invalid input for tool writeFile",
      },
      {
        type: "tool-error",
        toolCallId: "call_2",
        toolName: "updateNotification",
        input: { message: "far too long" },
        error: "AI_InvalidToolInputError",
      },
    ]);

    expect(records.map((r) => [r.toolName, r.inputKind])).toEqual([
      ["writeFile", "unparseable"],
      ["updateNotification", "parsed"],
    ]);
  });

  it("says nothing about a step whose tool calls all succeeded", () => {
    expect(
      rejectedToolInputs([
        { type: "text", text: "done" },
        { type: "tool-call", toolCallId: "call_1", toolName: "listBoards" },
        {
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "listBoards",
          input: { workspaceId: "ws-1" },
          output: { boards: [] },
        },
      ]),
    ).toEqual([]);
  });

  it("ignores content it cannot read rather than throwing inside a log call", () => {
    expect(rejectedToolInputs(undefined)).toEqual([]);
    expect(rejectedToolInputs("not an array")).toEqual([]);
    expect(rejectedToolInputs([null, 42, { type: "tool-error" }])).toEqual([
      { inputType: "undefined", inputKind: "absent" },
    ]);
  });
});
