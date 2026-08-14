import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  APICallError,
  InvalidToolInputError,
  LoadAPIKeyError,
  NoSuchToolError,
  TypeValidationError,
} from "ai";
import { z } from "zod";
import { serializeLoggedError } from "../log-serializers.ts";
import { formatStreamError } from "./stream-error.ts";

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

/**
 * The real error the SDK raises when a tool call's arguments fail their input
 * schema: an `InvalidToolInputError` wrapping a `TypeValidationError` wrapping
 * the `ZodError`. Built from a real Zod failure so the shape can't drift from
 * what the SDK actually produces.
 */
const invalidToolInput = (opts: {
  toolName: string;
  schema: z.ZodType;
  value: unknown;
}) => {
  const parsed = opts.schema.safeParse(opts.value);
  const cause = new TypeValidationError({
    value: opts.value,
    cause: parsed.error,
  });
  return new InvalidToolInputError({
    toolName: opts.toolName,
    toolInput: JSON.stringify(opts.value),
    cause,
  });
};

describe("formatStreamError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("existing branches are preserved", () => {
    it("names a missing API key", () => {
      expect(
        formatStreamError(new LoadAPIKeyError({ message: "no key" })),
      ).toBe("AI provider API key is missing or not configured.");
    });

    it.each([
      [401, "AI provider authentication failed"],
      [403, "AI provider authentication failed"],
      [429, "rate limit exceeded"],
      [500, "currently unavailable"],
      [503, "currently unavailable"],
    ])("maps HTTP %i to a specific message", (statusCode, expected) => {
      const error = new APICallError({
        message: "boom",
        url: "https://example.test",
        requestBodyValues: {},
        statusCode,
      });
      expect(formatStreamError(error)).toContain(expected);
    });

    it("falls back to the message of an unrecognised Error", () => {
      expect(formatStreamError(new Error("something specific"))).toBe(
        "something specific",
      );
    });
  });

  describe("invalid tool input", () => {
    const schema = z.object({ body: z.string().min(1).max(2000) });

    it("names the tool and the failing field rather than returning the raw message", () => {
      const error = invalidToolInput({
        toolName: "updateNotification",
        schema,
        value: { body: "x".repeat(2900) },
      });

      const formatted = formatStreamError(error);

      expect(formatted).toContain("updateNotification");
      expect(formatted).toContain("body");
      expect(formatted).toMatch(/2000/);
      // The whole point: this must REPLACE the SDK's message, which embeds the
      // entire rejected value plus the serialized ZodError.
      expect(formatted).not.toBe(error.message);
      expect(formatted).not.toContain("x".repeat(50));
    });

    it("stays short even when the rejected value is enormous", () => {
      const error = invalidToolInput({
        toolName: "updateNotification",
        schema,
        value: { body: "y".repeat(40000) },
      });

      expect(formatStreamError(error).length).toBeLessThan(500);
    });

    it("reports every failing field when more than one is invalid", () => {
      const multi = z.object({
        title: z.string().max(5),
        body: z.string().min(10),
      });
      const error = invalidToolInput({
        toolName: "createNotification",
        schema: multi,
        value: { title: "far too long", body: "short" },
      });

      const formatted = formatStreamError(error);
      expect(formatted).toContain("title");
      expect(formatted).toContain("body");
    });

    it("still names the tool when the cause carries no Zod issues", () => {
      const error = new InvalidToolInputError({
        toolName: "mysteryTool",
        toolInput: "{}",
        cause: new Error("unparseable"),
      });

      const formatted = formatStreamError(error);
      expect(formatted).toContain("mysteryTool");
      expect(formatted).toContain("unparseable");
    });
  });

  // Where the two surfaces used to disagree. A union reports why every branch
  // failed, and only a descent that concatenates the union's path with the
  // branch's produces the one path worth reading. The log serializer flattened
  // and this did not, so the log named the field while the user — and, on a
  // failed step, the model asked to correct itself — got `payload: Invalid
  // input`.
  describe("invalid tool input rejected by a union", () => {
    const schema = z.object({
      payload: z.union([
        z.object({
          kind: z.literal("a"),
          items: z.array(z.object({ id: z.string() })),
        }),
        z.object({ kind: z.literal("b"), value: z.number() }),
      ]),
    });
    const value = { payload: { kind: "a", items: [{ id: 42 }] } };
    const rejected = () =>
      invalidToolInput({ toolName: "recordPayload", schema, value });

    it("names the field the union rejected rather than the union", () => {
      const formatted = formatStreamError(rejected());

      expect(formatted).toContain("recordPayload");
      expect(formatted).toContain("payload.items[0].id");
      expect(formatted).not.toContain("payload: Invalid input");
      expect(formatted).not.toContain("invalid_union");
    });

    it("tells the log exactly what it tells the user", () => {
      const error = rejected();

      const streamed = formatStreamError(error);
      const logged = JSON.stringify(serializeLoggedError(error));

      const line =
        "payload.items[0].id: Invalid input: expected string, received number";
      expect(streamed).toContain(line);
      expect(logged).toContain(line);
    });
  });

  // The streaming path never hands the formatter an Error for this case. An
  // invalid tool call is converted to a `tool-error` stream part whose `error`
  // is `getErrorMessage(cause)` — i.e. `error.toString()`, a plain string — so
  // `isInstance` is false and the real production failure lands here. Both
  // production log lines from the reported incident are represented below.
  describe("invalid tool input arriving as a stringified error", () => {
    const stringified = (toolName: string, issues: unknown) =>
      `AI_InvalidToolInputError: Invalid input for tool ${toolName}: ` +
      `AI_TypeValidationError: Type validation failed: Value: ${JSON.stringify({ body: "z".repeat(2900) })}.\n` +
      `Error message: ${JSON.stringify(issues, null, 2)}`;

    it("names the tool and the failing field instead of the generic fallback", () => {
      const formatted = formatStreamError(
        stringified("updateNotification", [
          {
            origin: "string",
            code: "too_big",
            maximum: 2000,
            path: ["body"],
            message: "Too big: expected string to have <=2000 characters",
          },
        ]),
      );

      expect(formatted).toContain("updateNotification");
      expect(formatted).toContain("body");
      expect(formatted).toContain("2000");
      expect(formatted).not.toContain("An unexpected error occurred");
      // The rejected value must not be echoed back.
      expect(formatted).not.toContain("z".repeat(50));
      expect(formatted.length).toBeLessThan(500);
    });

    it("still names the tool when the issue JSON cannot be parsed", () => {
      const formatted = formatStreamError(
        "AI_InvalidToolInputError: Invalid input for tool upsertSkill: something went wrong",
      );

      expect(formatted).toContain("upsertSkill");
      expect(formatted).not.toContain("An unexpected error occurred");
    });

    it("passes an unrecognised string through rather than discarding it", () => {
      // Previously ANY string hit the generic fallback and its content was lost.
      expect(formatStreamError("upstream connection reset")).toContain(
        "upstream connection reset",
      );
    });
  });

  describe("unknown tool", () => {
    it("names the tool the model tried to call", () => {
      const error = new NoSuchToolError({
        toolName: "delegateToDashboardAgent",
        availableTools: ["delegateToObsidianAgent"],
      });

      const formatted = formatStreamError(error);
      expect(formatted).toContain("delegateToDashboardAgent");
      expect(formatted).not.toBe("An unexpected error occurred.");
    });
  });

  describe("generic fallback", () => {
    // Strings are handled above — they carry their own message and are
    // returned rather than replaced. The fallback is for values that don't.
    it.each([
      ["a plain object throw", { nope: true }],
      ["a null throw", null],
      ["an undefined throw", undefined],
    ])("records what actually arrived for %s", (_label, thrown) => {
      const formatted = formatStreamError(thrown);
      expect(formatted).toContain("An unexpected error occurred");
      // Must carry enough to identify the value that arrived — the reported
      // failure hit this branch and the type was never captured.
      expect(formatted.length).toBeGreaterThan(
        "An unexpected error occurred.".length,
      );
    });
  });
});
