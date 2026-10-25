import { describe, it, expect } from "vitest";
import { generateText, jsonSchema, tool } from "ai";
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { buildModelInvocation } from "./run-plan.ts";
import {
  capToolResult,
  MAX_TOOL_RESULT_CHARS,
  normalizeToolResults,
  truncatedToolResultMarker,
} from "../services/tool-result.ts";

/**
 * Issue #1618. A tool result over the cap is cut where every Drive assembles
 * its model arguments, so the cut form is what the next step is sent and what
 * the step reports, which a Chat persists. Covers a tool
 * a Tool set or MCP server contributes (already normalized at its loader seam)
 * and one core builds itself (not normalized), since the cap is for both.
 */

const USAGE = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

const OVERSIZED = "x".repeat(MAX_TOOL_RESULT_CHARS + 50);

/** Calls both tools on its first step, then stops; records every prompt. */
const twoToolModel = (prompts: LanguageModelV3CallOptions["prompt"][]) => {
  let step = 0;
  return new MockLanguageModelV3({
    doGenerate: (options) => {
      prompts.push(options.prompt);
      step++;
      return Promise.resolve(
        step === 1
          ? {
              content: [
                {
                  type: "tool-call" as const,
                  toolCallId: "mcp1",
                  toolName: "mcp_fetch",
                  input: "{}",
                },
                {
                  type: "tool-call" as const,
                  toolCallId: "core1",
                  toolName: "loadSkill",
                  input: "{}",
                },
              ],
              finishReason: { unified: "tool-calls" as const, raw: "tool" },
              usage: USAGE,
              warnings: [],
            }
          : {
              content: [{ type: "text" as const, text: "done" }],
              finishReason: { unified: "stop" as const, raw: "stop" },
              usage: USAGE,
              warnings: [],
            },
      );
    },
  });
};

/** Each tool result's output in a prompt, keyed by tool call. */
const toolOutputs = (prompt: LanguageModelV3CallOptions["prompt"]) =>
  Object.fromEntries(
    prompt
      .flatMap((m) => (m.role === "tool" ? m.content : []))
      .flatMap((p) =>
        p.type === "tool-result" ? [[p.toolCallId, p.output] as const] : [],
      ),
  );

const noInput = jsonSchema<Record<string, never>>({ type: "object" });

describe("tool result size cap", () => {
  it("cuts an oversized MCP and core result before the next step and in the response", async () => {
    const prompts: LanguageModelV3CallOptions["prompt"][] = [];
    const tools = {
      ...normalizeToolResults({
        mcp_fetch: tool({
          inputSchema: noInput,
          execute: () =>
            Promise.resolve({ content: [{ type: "text", text: OVERSIZED }] }),
        }),
      }),
      loadSkill: tool({ inputSchema: noInput, execute: () => OVERSIZED }),
    };
    const result = await generateText({
      ...buildModelInvocation(
        { model: twoToolModel(prompts), tools, maxSteps: 5 },
        { abortSignal: new AbortController().signal },
      ),
      prompt: "go",
    });

    const cut = (text: string) =>
      `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n${truncatedToolResultMarker(text.length)}`;
    const expected = {
      mcp1: cut(
        JSON.stringify({ content: [{ type: "text", text: OVERSIZED }] }),
      ),
      core1: cut(OVERSIZED),
    };

    // What the next model step was sent.
    const sent = toolOutputs(prompts[1] ?? []);
    // Compared as booleans: a failing diff of two 200k strings is unreadable.
    expect(
      Object.entries(expected).every(
        ([id, value]) =>
          JSON.stringify(sent[id]) === JSON.stringify({ type: "text", value }),
      ),
    ).toBe(true);

    // What the step reports, which the UI stream a Chat persists is built from.
    const reported = Object.fromEntries(
      (result.steps[0]?.toolResults ?? []).map((r) => [r.toolCallId, r.output]),
    );
    expect(JSON.stringify(reported) === JSON.stringify(expected)).toBe(true);
  });

  it("leaves a result within the cap as it was", async () => {
    const prompts: LanguageModelV3CallOptions["prompt"][] = [];
    const tools = {
      mcp_fetch: tool({ inputSchema: noInput, execute: () => ({ ok: true }) }),
      loadSkill: tool({ inputSchema: noInput, execute: () => "small" }),
    };
    await generateText({
      ...buildModelInvocation(
        { model: twoToolModel(prompts), tools, maxSteps: 5 },
        { abortSignal: new AbortController().signal },
      ),
      prompt: "go",
    });
    const outputs = (prompts[1] ?? [])
      .flatMap((m) => (m.role === "tool" ? m.content : []))
      .flatMap((p) => (p.type === "tool-result" ? [p.output] : []));
    expect(outputs).toEqual([
      { type: "json", value: { ok: true } },
      { type: "text", value: "small" },
    ]);
  });

  it("never splits a surrogate pair at the cut", () => {
    const text = `${"x".repeat(MAX_TOOL_RESULT_CHARS - 1)}🦆tail`;
    const cut = capToolResult(text, "t") as string;
    expect(cut.startsWith(`${"x".repeat(MAX_TOOL_RESULT_CHARS - 1)}\n[`)).toBe(
      true,
    );
  });
});
