import { describe, it, expect } from "vitest";
import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { moveToolResultFiles } from "./tool-result-files.ts";

const PNG = new Uint8Array([1, 2, 3]);

const call = (toolCallId: string, toolName = "fsView") => ({
  type: "tool-call" as const,
  toolCallId,
  toolName,
  input: {},
});

const fileResult = (toolCallId: string, filename: string) => ({
  type: "tool-result" as const,
  toolCallId,
  toolName: "fsView",
  output: {
    type: "content" as const,
    value: [
      { type: "text" as const, text: `\`${filename}\` attached below.` },
      {
        type: "file" as const,
        data: { type: "data" as const, data: PNG },
        mediaType: "image/png",
        filename,
      },
    ],
  },
});

const jsonResult = (toolCallId: string, toolName = "fsList") => ({
  type: "tool-result" as const,
  toolCallId,
  toolName,
  output: { type: "json" as const, value: { entries: [] } },
});

describe("moveToolResultFiles", () => {
  it("returns a prompt without tool-result files unchanged", () => {
    const prompt: LanguageModelV4Prompt = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [call("c1", "fsList")] },
      { role: "tool", content: [jsonResult("c1")] },
    ];
    expect(moveToolResultFiles(prompt)).toBe(prompt);
  });

  it("puts a placeholder where the file was and keeps the text parts", () => {
    const prompt: LanguageModelV4Prompt = [
      { role: "assistant", content: [call("c1")] },
      { role: "tool", content: [fileResult("c1", "chart.png")] },
    ];
    const [, tool] = moveToolResultFiles(prompt);
    expect(tool).toEqual({
      role: "tool",
      content: [
        {
          ...fileResult("c1", "chart.png"),
          output: {
            type: "content",
            value: [
              { type: "text", text: "`chart.png` attached below." },
              {
                type: "text",
                text: "(file attached in the following user message)",
              },
            ],
          },
        },
      ],
    });
  });

  it("adds one labelled user message after the last tool message of the run", () => {
    const prompt: LanguageModelV4Prompt = [
      { role: "user", content: [{ type: "text", text: "look" }] },
      {
        role: "assistant",
        content: [call("c1"), call("c2", "fsList"), call("c3")],
      },
      { role: "tool", content: [fileResult("c1", "a.png")] },
      { role: "tool", content: [jsonResult("c2")] },
      { role: "tool", content: [fileResult("c3", "b.png")] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ];
    const moved = moveToolResultFiles(prompt);
    expect(moved.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "tool",
      "user",
      "assistant",
    ]);
    expect(moved[5]).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: "File from tool result `fsView` (call 1): `a.png`",
        },
        {
          type: "file",
          data: { type: "data", data: PNG },
          mediaType: "image/png",
          filename: "a.png",
        },
        {
          type: "text",
          text: "File from tool result `fsView` (call 3): `b.png`",
        },
        {
          type: "file",
          data: { type: "data", data: PNG },
          mediaType: "image/png",
          filename: "b.png",
        },
      ],
    });
  });

  it("closes each run of tool messages separately", () => {
    const prompt: LanguageModelV4Prompt = [
      { role: "assistant", content: [call("c1")] },
      { role: "tool", content: [fileResult("c1", "a.png")] },
      { role: "assistant", content: [call("c2")] },
      { role: "tool", content: [fileResult("c2", "b.png")] },
    ];
    expect(moveToolResultFiles(prompt).map((m) => m.role)).toEqual([
      "assistant",
      "tool",
      "user",
      "assistant",
      "tool",
      "user",
    ]);
  });
});
