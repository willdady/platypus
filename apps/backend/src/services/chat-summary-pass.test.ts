import { beforeEach, describe, expect, it, vi } from "vitest";
// First, so its `vi.mock` of the database module is installed before the
// module under test imports the real handle.
import { resetMockDb, seedDb } from "../test-utils.ts";
import { APICallError } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { PlatypusUIMessage } from "../types.ts";
import {
  registerTranscriptSummary,
  takeTranscriptSummary,
  TRANSCRIPT_SUMMARY_REQUEST,
  type ChatSummaryRow,
} from "./chat-summary.ts";

/**
 * The IO half of Transcript summarising (ADR-0041, issue #1716): what one pass
 * writes, what it hands the model, and how it fails. The pure read-time rules
 * are pinned in `chat-summary.test.ts`.
 */

const USAGE = {
  inputTokens: {
    total: 120,
    noCache: 120,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 40, text: 40, reasoning: undefined },
};

const user = (id: string, text = id): PlatypusUIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

const assistant = (
  id: string,
  metadata?: PlatypusUIMessage["metadata"],
): PlatypusUIMessage => ({
  id,
  role: "assistant",
  parts: [{ type: "text", text: `reply ${id}` }],
  ...(metadata ? { metadata } : {}),
});

/** A Chat of six turns; the last 4 stay verbatim, so the anchor is a1. */
const sixTurns = (): PlatypusUIMessage[] => [
  user("u1"),
  assistant("a1"),
  user("u2"),
  assistant("a2"),
  user("u3"),
  assistant("a3"),
  user("u4"),
  assistant("a4"),
  user("u5"),
  assistant("a5"),
  user("u6"),
  assistant("a6"),
];

const seedSummaryTable = () => seedDb({ chat_summary: [] });

/** A model answering with one summary, recording every prompt it was sent. */
const summaryModel = (prompts: PromptMessage[][] = [], text = "The summary.") =>
  new MockLanguageModelV3({
    doGenerate: (options) => {
      prompts.push(options.prompt as unknown as PromptMessage[]);
      return Promise.resolve({
        content: [{ type: "text" as const, text }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: USAGE,
        warnings: [],
      });
    },
  });

/** The parts of a prompt this test reads: roles and text. */
type PromptMessage = {
  role: string;
  content: ReadonlyArray<{ type: string; text?: string }>;
};

/** The text a prompt carries, from its user messages. */
const promptText = (prompt: readonly PromptMessage[]) =>
  prompt
    .flatMap((message) =>
      message.role === "user"
        ? message.content.flatMap((part) =>
            part.type === "text" && part.text !== undefined ? [part.text] : [],
          )
        : [],
    )
    .join("\n");

describe("takeTranscriptSummary", () => {
  beforeEach(() => {
    resetMockDb();
  });

  it("writes exactly one chat_summary row and no chat_message row", async () => {
    const fake = seedSummaryTable();
    const row = await takeTranscriptSummary({
      chatId: "chat-1",
      model: summaryModel(),
      modelId: "openai:gpt",
      path: sixTurns(),
      triggeredFromOccupancy: 8_200,
      previousSummary: undefined,
      readingSummaryId: undefined,
      now: () => new Date("2026-02-01T00:00:00Z"),
      generateId: () => "sum-1",
    });

    expect(row).toMatchObject({
      id: "sum-1",
      chatId: "chat-1",
      // The last 4 turns (u3..a6) stay verbatim: the anchor is a2.
      anchorId: "a2",
      coveredIds: ["u1", "a1", "u2", "a2"],
      text: "The summary.",
      stats: {
        modelId: "openai:gpt",
        inputTokens: 120,
        outputTokens: 40,
        triggeredFromOccupancy: 8_200,
      },
    });
    expect(fake.tables.chat_summary).toHaveLength(1);
    // No message is ever written or changed by this feature (ADR-0026).
    expect(
      fake.queries.filter(
        (query) =>
          query.table === "chat_message" &&
          (query.kind === "insert" ||
            query.kind === "update" ||
            query.kind === "delete"),
      ),
    ).toEqual([]);
  });

  it("keeps one turn when the triggering reading was taken with a summary", async () => {
    seedSummaryTable();
    const row = await takeTranscriptSummary({
      chatId: "chat-1",
      model: summaryModel(),
      modelId: "openai:gpt",
      path: sixTurns(),
      triggeredFromOccupancy: 8_200,
      previousSummary: undefined,
      readingSummaryId: "sum-old",
    });
    // The last turn only (u6..a6) stays verbatim: the anchor is a5.
    expect(row?.anchorId).toBe("a5");
    expect(row?.coveredIds).toEqual([
      "u1",
      "a1",
      "u2",
      "a2",
      "u3",
      "a3",
      "u4",
      "a4",
      "u5",
      "a5",
    ]);
  });

  it("is incremental: the previous summary plus the messages after its anchor", async () => {
    seedSummaryTable();
    const prompts: PromptMessage[][] = [];
    const previous: ChatSummaryRow = {
      id: "sum-old",
      chatId: "chat-1",
      anchorId: "a1",
      coveredIds: ["u1", "a1"],
      text: "The earlier summary.",
      stats: null,
      createdAt: new Date(),
    };
    await takeTranscriptSummary({
      chatId: "chat-1",
      model: summaryModel(prompts),
      modelId: "openai:gpt",
      path: sixTurns(),
      triggeredFromOccupancy: 8_200,
      previousSummary: previous,
      readingSummaryId: "sum-old",
    });
    const sent = promptText(prompts[0] ?? []);
    expect(sent).toContain("The earlier summary.");
    // u2 onwards: u1 is already condensed into the previous summary.
    expect(sent).toContain("u2");
    expect(sent).not.toContain("u1");
  });

  it("retries once with an earlier anchor on a context overflow", async () => {
    seedSummaryTable();
    const prompts: PromptMessage[][] = [];
    let call = 0;
    const model = new MockLanguageModelV3({
      doGenerate: (options) => {
        prompts.push(options.prompt as unknown as PromptMessage[]);
        call += 1;
        if (call === 1) {
          return Promise.reject(
            new APICallError({
              message: "prompt is too long: context length exceeded",
              statusCode: 400,
              url: "https://example.test/v1",
              requestBodyValues: {},
            }),
          );
        }
        return Promise.resolve({
          content: [{ type: "text" as const, text: "Retried summary." }],
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: USAGE,
          warnings: [],
        });
      },
    });
    const row = await takeTranscriptSummary({
      chatId: "chat-1",
      model,
      modelId: "openai:gpt",
      path: sixTurns(),
      triggeredFromOccupancy: 9_800,
      previousSummary: undefined,
      readingSummaryId: undefined,
    });
    expect(prompts).toHaveLength(2);
    // The retry ends one turn earlier: the anchor moves from a2 to a1.
    expect(row?.anchorId).toBe("a1");
    expect(row?.coveredIds).toEqual(["u1", "a1"]);
  });

  it("a second overflow is an ordinary failed summary: no row, no throw", async () => {
    const fake = seedSummaryTable();
    const model = new MockLanguageModelV3({
      doGenerate: () =>
        Promise.reject(
          new APICallError({
            message: "maximum context length exceeded",
            statusCode: 400,
            url: "https://example.test/v1",
            requestBodyValues: {},
          }),
        ),
    });
    const row = await takeTranscriptSummary({
      chatId: "chat-1",
      model,
      modelId: "openai:gpt",
      path: sixTurns(),
      triggeredFromOccupancy: 9_800,
      previousSummary: undefined,
      readingSummaryId: undefined,
    });
    expect(row).toBeUndefined();
    expect(fake.tables.chat_summary).toHaveLength(0);
  });

  it("a thrown model error is never fatal: logged, no row", async () => {
    seedSummaryTable();
    const model = new MockLanguageModelV3({
      doGenerate: () => Promise.reject(new Error("provider exploded")),
    });
    await expect(
      takeTranscriptSummary({
        chatId: "chat-1",
        model,
        modelId: "openai:gpt",
        path: sixTurns(),
        triggeredFromOccupancy: 8_200,
        previousSummary: undefined,
        readingSummaryId: undefined,
      }),
    ).resolves.toBeUndefined();
  });

  it("ends the model's input on a user request, never on the anchor's assistant message", async () => {
    seedSummaryTable();
    const prompts: PromptMessage[][] = [];
    await takeTranscriptSummary({
      chatId: "chat-1",
      model: summaryModel(prompts),
      modelId: "openai:gpt",
      path: sixTurns(),
      triggeredFromOccupancy: 8_200,
      previousSummary: undefined,
      readingSummaryId: undefined,
    });
    const last = prompts[0]?.at(-1);
    expect(last?.role).toBe("user");
    expect(last?.content[0]?.text).toBe(TRANSCRIPT_SUMMARY_REQUEST);
  });

  it("a blank reply is a failed summary: no row, no throw", async () => {
    const fake = seedSummaryTable();
    await expect(
      takeTranscriptSummary({
        chatId: "chat-1",
        model: summaryModel([], " "),
        modelId: "openai:gpt",
        path: sixTurns(),
        triggeredFromOccupancy: 8_200,
        previousSummary: undefined,
        readingSummaryId: undefined,
      }),
    ).resolves.toBeUndefined();
    expect(fake.tables.chat_summary).toHaveLength(0);
  });

  it("writes no summary when the path has no full tail to keep", async () => {
    const fake = seedSummaryTable();
    const row = await takeTranscriptSummary({
      chatId: "chat-1",
      model: summaryModel(),
      modelId: "openai:gpt",
      path: [user("u1"), assistant("a1"), user("u2"), assistant("a2")],
      triggeredFromOccupancy: 8_200,
      previousSummary: undefined,
      readingSummaryId: undefined,
    });
    expect(row).toBeUndefined();
    expect(fake.tables.chat_summary).toHaveLength(0);
  });
});

describe("the in-flight registry", () => {
  beforeEach(() => {
    resetMockDb();
  });

  it("joins a pass already in flight for the Chat instead of starting a second", async () => {
    const first = Promise.withResolvers<ChatSummaryRow | undefined>();
    const start = vi.fn(() => first.promise);
    const a = registerTranscriptSummary("chat-1", start);
    const b = registerTranscriptSummary("chat-1", start);
    expect(start).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    first.resolve(undefined);
    await a;
    // A finished pass is forgotten, so the next one starts fresh.
    const later = registerTranscriptSummary("chat-1", () =>
      Promise.resolve(undefined),
    );
    await expect(later).resolves.toBeUndefined();
  });
});
