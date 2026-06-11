import { describe, it, expect, vi } from "vitest";

vi.mock("../index.ts", () => ({ db: {} })); // drizzle store unused in these tests
vi.mock("../logger.ts", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { APICallError } from "ai";
import {
  contextOverflowRecoveryMiddleware,
  isContextOverflowError,
  trimOverflowingPrompt,
  type RecoveryContext,
} from "./recovery.ts";

const apiError = (args: {
  message?: string;
  statusCode: number;
  responseBody?: string;
}) =>
  new APICallError({
    message: args.message ?? "Bad Request",
    url: "https://provider.example/v1",
    requestBodyValues: {},
    statusCode: args.statusCode,
    responseBody: args.responseBody,
  });

// --- isContextOverflowError — per-provider body matrix (drift T9) ---------

describe("isContextOverflowError (drift T9)", () => {
  it("matches the OpenAI phrasing + code", () => {
    const err = apiError({
      statusCode: 400,
      responseBody: JSON.stringify({
        error: {
          message:
            "This model's maximum context length is 8192 tokens. However, your messages resulted in 10042 tokens. Please reduce the length of the messages.",
          type: "invalid_request_error",
          code: "context_length_exceeded",
        },
      }),
    });
    expect(isContextOverflowError(err)).toBe(true);
  });

  it("matches the Anthropic phrasing", () => {
    const err = apiError({
      statusCode: 400,
      message: "prompt is too long: 210042 tokens > 200000 maximum",
    });
    expect(isContextOverflowError(err)).toBe(true);
  });

  it("matches the vLLM / OpenAI-compatible phrasing", () => {
    const err = apiError({
      statusCode: 400,
      responseBody:
        '{"object":"error","message":"This model\'s maximum context length is 40960 tokens. However, you requested 45123 tokens (40123 in the messages, 5000 in the completion). Please reduce the length of the messages or completion.","code":40303}',
    });
    expect(isContextOverflowError(err)).toBe(true);
  });

  it("matches the Google phrasing", () => {
    const err = apiError({
      statusCode: 400,
      responseBody:
        '{"error":{"code":400,"message":"The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).","status":"INVALID_ARGUMENT"}}',
    });
    expect(isContextOverflowError(err)).toBe(true);
  });

  it("matches the Bedrock ValidationException phrasing", () => {
    const err = apiError({
      statusCode: 400,
      responseBody: '{"message":"Input is too long for requested model."}',
    });
    expect(isContextOverflowError(err)).toBe(true);
  });

  it("matches a 413 payload-too-large with a token message", () => {
    const err = apiError({
      statusCode: 413,
      responseBody: '{"error":"too many tokens in request"}',
    });
    expect(isContextOverflowError(err)).toBe(true);
  });

  it("rejects a 400 that is not about context (validation error)", () => {
    const err = apiError({
      statusCode: 400,
      responseBody:
        '{"error":{"message":"Invalid value for temperature: must be between 0 and 2."}}',
    });
    expect(isContextOverflowError(err)).toBe(false);
  });

  it("rejects 429 / 401 / 5xx regardless of body", () => {
    for (const statusCode of [401, 429, 500, 503]) {
      const err = apiError({
        statusCode,
        responseBody: '{"error":"maximum context length exceeded"}',
      });
      expect(isContextOverflowError(err)).toBe(false);
    }
  });

  it("rejects non-APICallError values", () => {
    expect(isContextOverflowError(new Error("prompt is too long"))).toBe(false);
    expect(isContextOverflowError(undefined)).toBe(false);
  });
});

// --- middleware: trim + retry-once (§E, drift T3) --------------------------

type PromptMsg = { role: string; content: unknown };

const text = (role: "user" | "assistant", t: string): PromptMsg => ({
  role,
  content: [{ type: "text", text: t }],
});

/** system + 2 big + 2 small messages: prune can't help (no tool results), so
 * the trim must go through the shared summarize stage (drift T3). */
const overflowPrompt = (): PromptMsg[] => [
  { role: "system", content: "SYS" },
  text("user", "X".repeat(4000)),
  text("assistant", "Y".repeat(4000)),
  text("user", "recent question"),
  text("assistant", "recent answer"),
];

const ctx = (over: Partial<RecoveryContext> = {}): RecoveryContext => ({
  chatId: "chat-1",
  imageProvider: "default",
  targetTokens: 100,
  keepRecentMessages: 4, // recovery halves this → keep 2
  minPrunableChars: 2000,
  summarize: async () => "RSUM",
  ...over,
});

const overflow = () =>
  apiError({
    statusCode: 400,
    responseBody: '{"error":{"code":"context_length_exceeded"}}',
  });

/** Fake V3 model capturing retry params. */
const fakeModel = (result: unknown = "RETRIED", fail?: unknown) => {
  const calls: Array<{ prompt: PromptMsg[] }> = [];
  const impl = async (params: { prompt: PromptMsg[] }) => {
    calls.push(params);
    if (fail) throw fail;
    return result;
  };
  return { calls, model: { doGenerate: impl, doStream: impl } };
};

const runWrapGenerate = (
  mw: ReturnType<typeof contextOverflowRecoveryMiddleware>,
  args: {
    doGenerate: () => Promise<unknown>;
    params: { prompt: PromptMsg[] };
    model: unknown;
  },
) =>
  (mw.wrapGenerate as (o: unknown) => Promise<unknown>)({
    doStream: async () => {
      throw new Error("unused");
    },
    ...args,
  });

describe("contextOverflowRecoveryMiddleware (§E)", () => {
  it("trims via the shared compactor and retries exactly once on overflow", async () => {
    const markDirty = vi.fn(async () => undefined);
    const mw = contextOverflowRecoveryMiddleware(ctx({ markDirty }));
    const { calls, model } = fakeModel();
    const doGenerate = vi.fn(async () => {
      throw overflow();
    });

    const result = await runWrapGenerate(mw, {
      doGenerate,
      params: { prompt: overflowPrompt() },
      model,
    });

    expect(result).toBe("RETRIED");
    expect(doGenerate).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);

    const retried = calls[0].prompt;
    // System head pinned verbatim at the front (§C).
    expect(retried[0]).toEqual({ role: "system", content: "SYS" });
    // The big prefix was replaced by the shared summary message (drift T3 —
    // compactModelMessages' shape, not a bespoke trim).
    const summary = retried[1] as { content: Array<{ text: string }> };
    expect(summary.content[0].text).toContain(
      "[Summary of earlier conversation]",
    );
    expect(summary.content[0].text).toContain("RSUM");
    // Recent messages kept verbatim.
    expect(retried.at(-1)).toEqual(text("assistant", "recent answer"));
    // Dirty flag persisted on DETECTION (before the retry outcome is known).
    expect(markDirty).toHaveBeenCalledTimes(1);
  });

  it("propagates the second overflow — no infinite retry", async () => {
    const markDirty = vi.fn(async () => undefined);
    const mw = contextOverflowRecoveryMiddleware(ctx({ markDirty }));
    const second = overflow();
    const { model } = fakeModel(undefined, second);

    await expect(
      runWrapGenerate(mw, {
        doGenerate: async () => {
          throw overflow();
        },
        params: { prompt: overflowPrompt() },
        model,
      }),
    ).rejects.toBe(second);
    // Flag persisted anyway: the NEXT turn must compact durably (drift T3).
    expect(markDirty).toHaveBeenCalledTimes(1);
  });

  it("rethrows non-overflow errors without retrying or flagging", async () => {
    const markDirty = vi.fn(async () => undefined);
    const mw = contextOverflowRecoveryMiddleware(ctx({ markDirty }));
    const { calls, model } = fakeModel();
    const authError = apiError({ statusCode: 401, message: "bad key" });

    await expect(
      runWrapGenerate(mw, {
        doGenerate: async () => {
          throw authError;
        },
        params: { prompt: overflowPrompt() },
        model,
      }),
    ).rejects.toBe(authError);
    expect(calls).toHaveLength(0);
    expect(markDirty).not.toHaveBeenCalled();
  });

  it("still retries when persisting the dirty flag fails (best-effort)", async () => {
    const markDirty = vi.fn(async () => {
      throw new Error("db down");
    });
    const mw = contextOverflowRecoveryMiddleware(ctx({ markDirty }));
    const { calls, model } = fakeModel();

    const result = await runWrapGenerate(mw, {
      doGenerate: async () => {
        throw overflow();
      },
      params: { prompt: overflowPrompt() },
      model,
    });
    expect(result).toBe("RETRIED");
    expect(calls).toHaveLength(1);
  });

  it("surfaces the ORIGINAL overflow when the trim itself fails", async () => {
    const first = overflow();
    const mw = contextOverflowRecoveryMiddleware(
      ctx({
        summarize: async () => {
          throw new Error("summarizer down");
        },
      }),
    );
    const { calls, model } = fakeModel();

    await expect(
      runWrapGenerate(mw, {
        doGenerate: async () => {
          throw first;
        },
        params: { prompt: overflowPrompt() },
        model,
      }),
    ).rejects.toBe(first);
    expect(calls).toHaveLength(0);
  });

  it("covers the stream path: doStream rejection is trimmed and retried", async () => {
    const mw = contextOverflowRecoveryMiddleware(ctx());
    const { calls, model } = fakeModel("STREAMED");

    const result = await (mw.wrapStream as (o: unknown) => Promise<unknown>)({
      doGenerate: async () => {
        throw new Error("unused");
      },
      doStream: async () => {
        throw overflow();
      },
      params: { prompt: overflowPrompt() },
      model,
    });
    expect(result).toBe("STREAMED");
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt[0]).toEqual({ role: "system", content: "SYS" });
  });
});

describe("trimOverflowingPrompt", () => {
  it("pins multiple leading system messages and halves keep-recent", async () => {
    const prompt: PromptMsg[] = [
      { role: "system", content: "S1" },
      { role: "system", content: "S2" },
      text("user", "A".repeat(4000)),
      text("assistant", "B".repeat(4000)),
      text("user", "u2"),
      text("assistant", "a2"),
    ];
    const { prompt: out, messagesDropped } = await trimOverflowingPrompt(
      prompt,
      ctx(), // keepRecentMessages 4 → recovery keeps 2
    );
    expect(out[0]).toEqual({ role: "system", content: "S1" });
    expect(out[1]).toEqual({ role: "system", content: "S2" });
    expect(messagesDropped).toBe(2); // the two big messages summarized away
    expect(out.at(-2)).toEqual(text("user", "u2"));
    expect(out.at(-1)).toEqual(text("assistant", "a2"));
  });

  it("never orphans a tool result at the keep boundary", async () => {
    const toolCall: PromptMsg = {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "t1", toolName: "search", input: {} },
      ],
    };
    const toolResult: PromptMsg = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "t1",
          toolName: "search",
          output: { type: "text", value: "Z".repeat(4000) },
        },
      ],
    };
    const prompt: PromptMsg[] = [
      { role: "system", content: "SYS" },
      text("user", "Q".repeat(4000)),
      toolCall,
      toolResult, // boundary at keep-2 would start recent here — must walk back
      text("assistant", "done"),
    ];
    const { prompt: out } = await trimOverflowingPrompt(prompt, ctx());
    const firstNonSystem = out.findIndex((m) => m.role !== "system");
    // Recent must not begin with an orphaned role:"tool" message.
    expect(out[firstNonSystem].role).not.toBe("tool");
    const toolIdx = out.findIndex((m) => m.role === "tool");
    if (toolIdx !== -1) {
      expect(out[toolIdx - 1].role).toBe("assistant");
    }
  });
});
