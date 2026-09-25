import { beforeEach, describe, it, expect, vi } from "vitest";
import type { z } from "zod";
import type { InferToolInput } from "ai";
import { validate, version as uuidVersion } from "uuid";
import { generateUuid, generateNanoId } from "./identifiers.ts";
import { callTool } from "../test-utils.ts";
import { mockNanoid } from "../test-setup.ts";

type UuidInput = InferToolInput<typeof generateUuid>;
type NanoIdInput = InferToolInput<typeof generateNanoId>;

const uuidSchema = generateUuid.inputSchema as z.ZodType<UuidInput>;
const nanoIdSchema = generateNanoId.inputSchema as z.ZodType<NanoIdInput>;

/**
 * `callTool` invokes `execute` directly, bypassing the AI SDK's schema-driven
 * defaulting that happens before `execute` runs in production. These helpers
 * resolve defaults through the schema first, so a test can omit an optional
 * field the same way a model call omitting it would behave for real.
 */
const callUuidTool = (input: Partial<UuidInput>) =>
  callTool(generateUuid, uuidSchema.parse(input));
const callNanoIdTool = (input: Partial<NanoIdInput>) =>
  callTool(generateNanoId, nanoIdSchema.parse(input));

describe("generateUuid", () => {
  it("with no arguments returns one hyphenated lowercase v4 UUID", async () => {
    const result = await callUuidTool({});
    expect(result.ids).toHaveLength(1);
    const id = result.ids[0];
    expect(validate(id)).toBe(true);
    expect(uuidVersion(id)).toBe(4);
    expect(id).toBe(id.toLowerCase());
  });

  it("with version v7 returns time-ordered v7 UUIDs", async () => {
    const result = await callUuidTool({ version: "v7" });
    const id = result.ids[0];
    expect(validate(id)).toBe(true);
    expect(uuidVersion(id)).toBe(7);

    const second = await callUuidTool({ version: "v7" });
    expect(id < second.ids[0]).toBe(true);
  });

  it("format no-hyphens returns a 32-character hex string with no hyphens", async () => {
    const result = await callUuidTool({ format: "no-hyphens" });
    expect(result.ids[0]).toMatch(/^[0-9a-f]{32}$/);
  });

  it("count: 100 returns 100 distinct ids", async () => {
    const result = await callUuidTool({ count: 100 });
    expect(result.ids).toHaveLength(100);
    expect(new Set(result.ids).size).toBe(100);
  });

  it.each([
    { version: "v1" },
    { format: "uppercase" },
    // Out-of-range counts are rejected, not clamped.
    { count: 0 },
    { count: 101 },
  ])("rejects %o", (input) => {
    expect(uuidSchema.safeParse(input).success).toBe(false);
  });
});

describe("generateNanoId", () => {
  // test-setup stubs `nanoid()` suite-wide; the url-safe path calls it, so
  // restore the real one here.
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("nanoid")>("nanoid");
    mockNanoid.mockImplementation(actual.nanoid);
  });

  it("with no arguments returns one 21-character lowercase-alphanumeric id", async () => {
    const result = await callNanoIdTool({});
    expect(result.ids).toHaveLength(1);
    expect(result.ids[0]).toMatch(/^[a-z0-9]{21}$/);
  });

  it.each([
    ["alphanumeric", /^[A-Za-z0-9]{32}$/],
    ["lowercase-alphanumeric", /^[a-z0-9]{32}$/],
    ["url-safe", /^[A-Za-z0-9_-]{32}$/],
  ] as const)("alphabet %s draws only from its pool", async (alphabet, re) => {
    const result = await callNanoIdTool({ alphabet, count: 20, size: 32 });
    for (const id of result.ids) expect(id).toMatch(re);
  });

  it("alphabet url-safe does draw - or _", async () => {
    const result = await callNanoIdTool({
      alphabet: "url-safe",
      count: 50,
      size: 32,
    });
    expect(result.ids.join("")).toMatch(/[-_]/);
  });

  it("size: 8 and size: 64 succeed", async () => {
    const small = await callNanoIdTool({ size: 8 });
    expect(small.ids[0]).toHaveLength(8);
    const large = await callNanoIdTool({ size: 64 });
    expect(large.ids[0]).toHaveLength(64);
  });

  it("count: 100 returns 100 distinct ids", async () => {
    const result = await callNanoIdTool({ count: 100 });
    expect(result.ids).toHaveLength(100);
    expect(new Set(result.ids).size).toBe(100);
  });

  it.each([{ size: 7 }, { size: 65 }, { count: 0 }, { count: 101 }])(
    "rejects %o",
    (input) => {
      expect(nanoIdSchema.safeParse(input).success).toBe(false);
    },
  );
});
