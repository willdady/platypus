import { describe, it, expect } from "vitest";
import { convertToModelMessages, type UIMessage } from "ai";
import {
  estimateTokens,
  uiMessagesToCountUnits,
  modelMessagesToCountUnits,
  parseImageDimensions,
  imageProviderFor,
  CHARS_PER_TOKEN,
  DEFAULT_NONTEXT_TOKENS,
  MODEL_BOUND_UI_PART_TYPES,
  type CountUnit,
} from "./token-estimate.ts";
import type { ModelMessage } from "ai";
import type { PlatypusUIMessage } from "../types.ts";

// A 24-byte PNG: 8-byte signature + IHDR length/type + width@16 + height@20.
function fakePng(width: number, height: number): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // signature
  b.set([0, 0, 0, 13], 8); // IHDR length
  b.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

// A minimal JPEG with a single SOF0 marker carrying dimensions.
function fakeJpeg(width: number, height: number): Uint8Array {
  const b = new Uint8Array(12);
  b.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08], 0); // SOI + SOF0 + len + prec
  const view = new DataView(b.buffer);
  view.setUint16(7, height);
  view.setUint16(9, width);
  return b;
}

function dataUrl(bytes: Uint8Array, mediaType = "image/png"): string {
  return `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
}

describe("estimateTokens (the single estimator, P2)", () => {
  it("applies char/4 to text only, rounding up", () => {
    const units: CountUnit[] = [
      { role: "user", text: "abcdefgh", nonText: [] },
    ];
    expect(estimateTokens(units)).toBe(8 / CHARS_PER_TOKEN);

    const odd: CountUnit[] = [{ role: "user", text: "abcde", nonText: [] }];
    expect(estimateTokens(odd)).toBe(2); // ceil(5/4)
  });

  it("sums across multiple units (role-agnostic total)", () => {
    const units: CountUnit[] = [
      { role: "system", text: "aaaa", nonText: [] },
      { role: "user", text: "bbbb", nonText: [] },
      { role: "assistant", text: "cccc", nonText: [] },
    ];
    expect(estimateTokens(units)).toBe(3);
  });
});

describe("modality table (drift T2 — never char/4 an image)", () => {
  it("anthropic: ceil(w*h/750)", () => {
    const units: CountUnit[] = [
      {
        role: "user",
        text: "",
        nonText: [{ provider: "anthropic", width: 100, height: 100 }],
      },
    ];
    expect(estimateTokens(units)).toBe(Math.ceil((100 * 100) / 750)); // 14
  });

  it("openai high detail: 85 + 170 per tile", () => {
    const units: CountUnit[] = [
      {
        role: "user",
        text: "",
        nonText: [{ provider: "openai", width: 100, height: 100 }],
      },
    ];
    expect(estimateTokens(units)).toBe(85 + 170 * 1); // single tile
  });

  it("openai low detail is a flat 85, even without dimensions", () => {
    const withDims: CountUnit[] = [
      {
        role: "user",
        text: "",
        nonText: [
          { provider: "openai", width: 4000, height: 4000, detail: "low" },
        ],
      },
    ];
    expect(estimateTokens(withDims)).toBe(85);

    const noDims: CountUnit[] = [
      {
        role: "user",
        text: "",
        nonText: [{ provider: "openai", detail: "low" }],
      },
    ];
    expect(estimateTokens(noDims)).toBe(85);
  });

  it("missing dimensions fall to the conservative default", () => {
    const units: CountUnit[] = [
      { role: "user", text: "", nonText: [{ provider: "anthropic" }] },
    ];
    expect(estimateTokens(units)).toBe(DEFAULT_NONTEXT_TOKENS);
  });

  it("unknown provider falls to the conservative default", () => {
    const units: CountUnit[] = [
      {
        role: "user",
        text: "",
        nonText: [{ provider: "default", width: 100, height: 100 }],
      },
    ];
    expect(estimateTokens(units)).toBe(DEFAULT_NONTEXT_TOKENS);
  });

  it("an image is NOT counted as char/4 of its base64 bytes", () => {
    const png = fakePng(64, 64);
    const ui: PlatypusUIMessage[] = [
      {
        id: "m1",
        role: "user",
        parts: [{ type: "file", mediaType: "image/png", url: dataUrl(png) }],
      } as PlatypusUIMessage,
    ];
    const tokens = estimateTokens(uiMessagesToCountUnits(ui, "anthropic"));
    // char/4 of the base64 data URL would be far larger than the table cost.
    const charsIfNaive = Math.ceil(dataUrl(png).length / CHARS_PER_TOKEN);
    expect(tokens).toBe(Math.ceil((64 * 64) / 750));
    expect(tokens).toBeLessThan(charsIfNaive);
  });
});

describe("parseImageDimensions (cheap header parse)", () => {
  it("reads PNG IHDR dimensions", () => {
    expect(parseImageDimensions(fakePng(800, 600))).toEqual({
      width: 800,
      height: 600,
    });
  });

  it("reads JPEG SOF dimensions", () => {
    expect(parseImageDimensions(fakeJpeg(320, 240))).toEqual({
      width: 320,
      height: 240,
    });
  });

  it("returns undefined for unrecognized bytes", () => {
    expect(parseImageDimensions(new Uint8Array([1, 2, 3, 4]))).toBeUndefined();
  });
});

describe("MODEL_BOUND filter (drift T1 — UI-only parts excluded)", () => {
  it("counts text but ignores reasoning / source / step-start / data parts", () => {
    const ui: PlatypusUIMessage[] = [
      {
        id: "m1",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "thinking hard about it" },
          { type: "text", text: "hello" },
          { type: "step-start" },
          { type: "source-url", sourceId: "s1", url: "https://example.com" },
          { type: "data-custom", data: { hidden: "payload" } },
        ],
      } as unknown as PlatypusUIMessage,
    ];
    const units = uiMessagesToCountUnits(ui);
    expect(units).toHaveLength(1);
    expect(units[0].text).toBe("hello");
    expect(units[0].nonText).toHaveLength(0);
  });

  it("only text/file UI part types are model-bound (RV10 — the documented set)", () => {
    expect([...MODEL_BOUND_UI_PART_TYPES]).toEqual(["text", "file"]);
    // The UI-only types the adapter must drop are NOT in the model-bound set.
    for (const uiOnly of [
      "reasoning",
      "source-url",
      "source-document",
      "step-start",
      "data-custom",
    ]) {
      expect(MODEL_BOUND_UI_PART_TYPES).not.toContain(uiOnly);
    }
  });
});

describe("tool-result output variants (RV10 — model adapter)", () => {
  const unit = (output: unknown): CountUnit => {
    const msg = {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "c1", toolName: "t", output },
      ],
    } as unknown as ModelMessage;
    return modelMessagesToCountUnits([msg])[0];
  };

  it("folds text / json / content value into char/4 text", () => {
    expect(unit({ type: "text", value: "hello world" }).text).toContain(
      "hello",
    );
    expect(unit({ type: "json", value: { a: 1 } }).text).toContain('"a"');
    expect(
      unit({ type: "content", value: [{ type: "text", text: "deep" }] }).text,
    ).toContain("deep");
  });

  it("uses the reason (not a value) for execution-denied", () => {
    expect(
      unit({ type: "execution-denied", reason: "blocked" }).text,
    ).toContain("blocked");
  });
});

describe("adapter equality (drift T1 — one estimate across both shapes)", () => {
  it("estimate(UI) === estimate(convertToModelMessages(UI)) exactly", async () => {
    const png = fakePng(128, 128);
    const ui: UIMessage[] = [
      {
        id: "s",
        role: "system",
        parts: [{ type: "text", text: "You are helpful." }],
      },
      {
        id: "u",
        role: "user",
        parts: [
          { type: "text", text: "What is the weather and look at this image?" },
          { type: "file", mediaType: "image/png", url: dataUrl(png) },
        ],
      },
      {
        id: "a",
        role: "assistant",
        parts: [
          { type: "text", text: "Let me check." },
          {
            type: "tool-getWeather",
            toolCallId: "call-1",
            state: "output-available",
            input: { city: "San Francisco", units: "metric" },
            output: { temperatureC: 18, condition: "foggy" },
          },
        ],
      } as unknown as UIMessage,
      {
        id: "a2",
        role: "assistant",
        parts: [{ type: "text", text: "It is 18C and foggy." }],
      },
    ];

    const model = await convertToModelMessages(ui);

    const uiTokens = estimateTokens(
      uiMessagesToCountUnits(ui as PlatypusUIMessage[], "openai"),
    );
    const modelTokens = estimateTokens(
      modelMessagesToCountUnits(model, "openai"),
    );

    expect(uiTokens).toBe(modelTokens);
    expect(uiTokens).toBeGreaterThan(0);
  });
});

describe("imageProviderFor", () => {
  it("maps provider types to cost families", () => {
    expect(imageProviderFor("Anthropic")).toBe("anthropic");
    expect(imageProviderFor("Bedrock")).toBe("anthropic");
    expect(imageProviderFor("OpenAI")).toBe("openai");
    expect(imageProviderFor("OpenRouter")).toBe("default");
    expect(imageProviderFor("Google")).toBe("default");
  });
});

// --- estimateOverheadTokens (drift C1) -------------------------------------

import { z } from "zod";
import { tool } from "ai";
import { estimateOverheadTokens } from "./token-estimate.ts";

describe("estimateOverheadTokens (drift C1)", () => {
  it("counts the system prompt at char/4", () => {
    const sys = "S".repeat(400);
    expect(estimateOverheadTokens(sys, {})).toBe(100);
  });

  it("handles missing system prompt and tools", () => {
    expect(estimateOverheadTokens(undefined, undefined)).toBe(0);
  });

  it("counts tool name, description, and serialized JSON schema", () => {
    const sys = "system";
    const base = estimateOverheadTokens(sys, {});
    const withTool = estimateOverheadTokens(sys, {
      searchDocuments: tool({
        description:
          "Searches the workspace document store and returns ranked matches.",
        inputSchema: z.object({
          query: z.string().describe("Full-text query string"),
          limit: z.number().optional().describe("Maximum results to return"),
        }),
      }),
    });
    // Name + description alone are ~20 tokens; the serialized schema (with
    // property names and descriptions) must push it well past that.
    expect(withTool).toBeGreaterThan(base + 40);
  });

  it("falls back to a conservative flat cost for unserializable schemas", () => {
    const tokens = estimateOverheadTokens("", {
      weird: { description: "", inputSchema: 42 } as never,
    });
    // Either the fallback constant fired or some serialization succeeded —
    // never zero, never a throw.
    expect(tokens).toBeGreaterThanOrEqual(2); // ≥ name chars / 4
    expect(Number.isFinite(tokens)).toBe(true);
  });

  it("scales with a realistic multi-tool agent (the 8888-vs-986 gap)", () => {
    const sys = "You are a helpful agent.\n".repeat(40); // ~1k chars
    const tools = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [
        `tool_${i}`,
        tool({
          description:
            "A realistically verbose tool description explaining inputs, outputs, constraints, and error behaviour for the model.",
          inputSchema: z.object({
            target: z.string().describe("The resource identifier to act on"),
            options: z
              .object({
                recursive: z.boolean().optional(),
                depth: z.number().optional(),
                filter: z.string().optional(),
              })
              .optional(),
          }),
        }),
      ]),
    );
    // The point of C1: this payload is large even with a short history.
    expect(estimateOverheadTokens(sys, tools)).toBeGreaterThan(500);
  });

  it("is stable across repeated calls (RV9 schema-cache must not change counts)", () => {
    const sys = "system prompt";
    const tools = {
      lookup: tool({
        description: "Look something up by id.",
        inputSchema: z.object({ id: z.string().describe("identifier") }),
      }),
    };
    const first = estimateOverheadTokens(sys, tools);
    // Same tool objects → WeakMap hit on the second call; the memoized schema
    // length must reproduce the exact token count, never drift.
    expect(estimateOverheadTokens(sys, tools)).toBe(first);
  });
});
