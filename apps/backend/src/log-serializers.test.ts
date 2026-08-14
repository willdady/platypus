import { describe, it, expect } from "vitest";
import { generateText } from "ai";
import { Writable } from "node:stream";
import pino from "pino";
import { z } from "zod";
import { errorSerializers, serializeLoggedError } from "./log-serializers.ts";

const sizeOf = (value: unknown) => JSON.stringify(value)?.length ?? 0;

/**
 * The production failure, rebuilt through the SDK rather than hand-assembled.
 *
 * A tool result carrying Drizzle `Date` values fails `standardizePrompt()`, so
 * the whole `InvalidPromptError` → `TypeValidationError` → `ZodError` chain is
 * the SDK's own. Validation happens before the model is resolved, so this makes
 * no network call.
 */
const invalidPromptError = async () => {
  const at = new Date("2026-01-01T00:00:00.000Z");
  const card = (n: number) => ({
    id: `card-${n}`,
    title: `Card ${n}`,
    createdAt: at,
    updatedAt: at,
  });
  const column = (n: number) => ({
    id: `col-${n}`,
    name: `Column ${n}`,
    createdAt: at,
    updatedAt: at,
    cards: [card(n * 3), card(n * 3 + 1), card(n * 3 + 2)],
  });
  const board = {
    id: "board-1",
    createdAt: at,
    updatedAt: at,
    columns: [column(0), column(1), column(2)],
  };

  try {
    await generateText({
      model: "openai/gpt-4o" as never,
      messages: [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              toolName: "list_boards",
              output: { type: "json", value: board as never },
            },
          ],
        },
      ],
    });
  } catch (error) {
    return error;
  }
  throw new Error("expected the prompt to be rejected");
};

/**
 * A real pino instance writing in-process, so the registration is exercised
 * through pino's own serializer dispatch rather than by calling the function
 * directly. Registering a serializer under a key that is not pino's `errorKey`
 * is the part most likely to break silently.
 */
const logLine = (payload: Record<string, unknown>): string => {
  let written = "";
  const sink = new Writable({
    write(chunk, _encoding, done) {
      written += String(chunk);
      done();
    },
  });
  pino({ serializers: errorSerializers }, sink).error(payload, "boom");
  return written;
};

describe("errorSerializers", () => {
  it("registers the same treatment for both keys pino might see", () => {
    expect(errorSerializers.error).toBe(serializeLoggedError);
    expect(errorSerializers.err).toBe(serializeLoggedError);
  });

  it("caps the reported failure identically under either key", async () => {
    const error = await invalidPromptError();

    const underError = logLine({ error });
    const underErr = logLine({ err: error });

    expect(underError.length).toBeLessThan(4096);
    expect(underErr.length).toBeLessThan(4096);
    for (const line of [underError, underErr]) {
      expect(line).toContain(
        "The messages do not match the ModelMessage[] schema",
      );
      expect(line).toMatch(/content\[0\]\.output\.value\.columns\[\d+\]/);
      expect(line).not.toContain("invalid_union");
    }
    // Same entry either way. Compared as the parsed payload rather than the
    // raw line, which also carries pino's own per-call timestamp.
    const parse = (line: string) => JSON.parse(line) as Record<string, unknown>;
    expect(parse(underError).error).toEqual(parse(underErr).err);
  });

  it("leaves a logged value that is not an error alone", () => {
    expect(logLine({ error: "upstream connection reset" })).toContain(
      "upstream connection reset",
    );
  });
});

describe("serializeLoggedError", () => {
  describe("the reported failure", () => {
    it("collapses a 320 KB nested ZodError into a readable entry", async () => {
      const error = await invalidPromptError();

      // The unserialized error is the problem this change exists to fix.
      expect(sizeOf(error)).toBeGreaterThan(100_000);
      expect(sizeOf(serializeLoggedError(error))).toBeLessThan(4096);
    });

    it("keeps the one sentence that names the failure", async () => {
      const serialized = serializeLoggedError(await invalidPromptError());

      // Non-enumerable on `Error`, so today it is absent from the log entirely.
      expect(JSON.stringify(serialized)).toContain(
        "The messages do not match the ModelMessage[] schema",
      );
    });

    it("keeps the absolute path of an offending field, indices included", async () => {
      const serialized = JSON.stringify(
        serializeLoggedError(await invalidPromptError()),
      );

      expect(serialized).toMatch(/content\[0\]\.output\.value\.columns\[\d+\]/);
      expect(serialized).toContain("createdAt");
    });

    it("does not complain about the message role it actually matched", async () => {
      // A tool message also fits the shape of an assistant message carrying a
      // tool result, so both union branches reach the offending field. Leading
      // with `expected "assistant"` sends the reader after the wrong thing.
      const serialized = JSON.stringify(
        serializeLoggedError(await invalidPromptError()),
      );

      expect(serialized).not.toContain('expected \\"assistant\\"');
    });

    it("drops the union search space", async () => {
      const serialized = JSON.stringify(
        serializeLoggedError(await invalidPromptError()),
      );

      expect(serialized).not.toContain("invalid_union");
    });

    it("says so when it had to leave issues out", async () => {
      const serialized = JSON.stringify(
        serializeLoggedError(await invalidPromptError()),
      );

      expect(serialized).toMatch(/\+\d+ more/);
    });

    it("does not echo the rejected payload back", async () => {
      const serialized = JSON.stringify(
        serializeLoggedError(await invalidPromptError()),
      );

      // `TypeValidationError` carries the entire offending value as an
      // enumerable property, which serializes today.
      expect(serialized).not.toContain("Card 7");
      expect(serialized).toMatch(/omitted/i);
    });
  });

  describe("ordinary errors keep what they carry today", () => {
    it("keeps message, stack and the cause chain", () => {
      const error = new Error("outer boom", { cause: new Error("inner boom") });
      const serialized = serializeLoggedError(error) as Record<string, unknown>;

      expect(serialized.type).toBe("Error");
      expect(serialized.message).toBe("outer boom");
      expect(serialized.stack).toContain("log-serializers.test");
      expect((serialized.cause as Record<string, unknown>).message).toBe(
        "inner boom",
      );
    });

    it("keeps the diagnostic properties of a provider error", () => {
      const error = Object.assign(new Error("rate limited"), {
        statusCode: 429,
        url: "https://api.example.test/v1/messages",
        isRetryable: true,
      });

      const serialized = serializeLoggedError(error) as Record<string, unknown>;

      expect(serialized.statusCode).toBe(429);
      expect(serialized.url).toBe("https://api.example.test/v1/messages");
      expect(serialized.isRetryable).toBe(true);
    });

    it("keeps a small structured property intact", () => {
      const error = Object.assign(new Error("boom"), {
        context: { workspaceId: "ws_1" },
      });

      const serialized = serializeLoggedError(error) as Record<string, unknown>;

      expect(serialized.context).toEqual({ workspaceId: "ws_1" });
    });

    it("replaces an oversized property with a marked placeholder", () => {
      const error = Object.assign(new Error("boom"), {
        payload: { blob: "q".repeat(20_000) },
      });

      const serialized = serializeLoggedError(error) as Record<string, unknown>;

      expect(String(serialized.payload)).toMatch(/omitted/i);
      expect(String(serialized.payload)).not.toContain("qqqqqqqqqq");
    });

    it("marks a message it had to shorten", () => {
      const serialized = serializeLoggedError(
        new Error("b".repeat(5000)),
      ) as Record<string, unknown>;

      expect(String(serialized.message)).toContain("…");
      expect(String(serialized.message).length).toBeLessThan(1000);
    });
  });

  describe("values that are not errors", () => {
    it.each([
      ["a string", "upstream connection reset"],
      ["a number", 42],
      ["null", null],
      ["undefined", undefined],
      ["a boolean", false],
    ])("passes %s through unchanged", (_label, value) => {
      expect(serializeLoggedError(value)).toBe(value);
    });

    it("serializes a plain object throw without inventing an Error shape", () => {
      const serialized = serializeLoggedError({ nope: true }) as Record<
        string,
        unknown
      >;

      expect(serialized.nope).toBe(true);
    });
  });

  describe("hostile shapes", () => {
    it("does not hang on a cyclic cause chain", () => {
      const a = new Error("a");
      const b = new Error("b", { cause: a });
      (a as { cause?: unknown }).cause = b;

      expect(() => serializeLoggedError(a)).not.toThrow();
      expect(sizeOf(serializeLoggedError(a))).toBeLessThan(4096);
    });

    it("does not hang on a self-referential property", () => {
      const error = new Error("boom") as Error & { self?: unknown };
      error.self = error;

      expect(() => serializeLoggedError(error)).not.toThrow();
    });

    it("handles a cause that is not an error", () => {
      const serialized = serializeLoggedError(
        new Error("boom", { cause: "a plain string cause" }),
      ) as Record<string, unknown>;

      expect(JSON.stringify(serialized)).toContain("a plain string cause");
    });

    it("keeps the message when the issue tree summarises to nothing", () => {
      // Suppressing the message because issues are *present* would lose the
      // only readable line when the tree yields no reportable leaf.
      const error = Object.assign(new Error("the failure still has a name"), {
        issues: [] as unknown[],
      });

      const serialized = serializeLoggedError(error) as Record<string, unknown>;

      expect(serialized.message).toBe("the failure still has a name");
    });

    it("says so rather than ending a long cause chain in silence", () => {
      let error = new Error("root cause");
      for (let link = 0; link < 8; link++) {
        error = new Error(`wrapper ${link}`, { cause: error });
      }

      const serialized = JSON.stringify(serializeLoggedError(error));

      expect(serialized).toMatch(/omitted: cause chain deeper than \d+ links/);
    });

    it("summarises a bare ZodError logged on its own", () => {
      const parsed = z.object({ body: z.string() }).safeParse({ body: 1 });
      const serialized = serializeLoggedError(
        (parsed as { error: unknown }).error,
      ) as Record<string, unknown>;

      expect(serialized.type).toBe("ZodError");
      expect(String(serialized.issues)).toContain("body");
    });
  });
});
