import { describe, it, expect } from "vitest";
import type { z } from "zod";
import type { InferToolInput } from "ai";
import { validate, version as uuidVersion } from "uuid";
import { generateUuid, generateNanoId } from "./identifiers.ts";
import { callTool } from "../test-utils.ts";

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

  it("format standard returns 36 characters", async () => {
    const result = await callUuidTool({ format: "standard" });
    expect(result.ids[0]).toHaveLength(36);
  });

  it("rejects a version other than v4/v7", () => {
    expect(uuidSchema.safeParse({ version: "v1" }).success).toBe(false);
  });

  it("rejects a format other than standard/no-hyphens", () => {
    expect(uuidSchema.safeParse({ format: "uppercase" }).success).toBe(false);
  });

  it("count: 100 returns 100 distinct ids", async () => {
    const result = await callUuidTool({ count: 100 });
    expect(result.ids).toHaveLength(100);
    expect(new Set(result.ids).size).toBe(100);
  });

  it("count: 0 is rejected as a validation error", () => {
    expect(uuidSchema.safeParse({ count: 0 }).success).toBe(false);
  });

  it("count: 101 is rejected as a validation error, not clamped", () => {
    expect(uuidSchema.safeParse({ count: 101 }).success).toBe(false);
  });

  it("returns an array for count: 1", async () => {
    const result = await callUuidTool({ count: 1 });
    expect(Array.isArray(result.ids)).toBe(true);
  });
});

describe("generateNanoId", () => {
  it("with no arguments returns one 21-character lowercase-alphanumeric id", async () => {
    const result = await callNanoIdTool({});
    expect(result.ids).toHaveLength(1);
    expect(result.ids[0]).toMatch(/^[a-z0-9]{21}$/);
  });

  it("alphabet url-safe can return - or _", async () => {
    const result = await callNanoIdTool({
      alphabet: "url-safe",
      count: 50,
      size: 32,
    });
    const combined = result.ids.join("");
    expect(/[-_]/.test(combined)).toBe(true);
  });

  it("alphabet alphanumeric returns only [A-Za-z0-9]", async () => {
    const result = await callNanoIdTool({
      alphabet: "alphanumeric",
      count: 10,
    });
    for (const id of result.ids) {
      expect(id).toMatch(/^[A-Za-z0-9]+$/);
    }
  });

  it("alphabet lowercase-alphanumeric returns only [a-z0-9]", async () => {
    const result = await callNanoIdTool({
      alphabet: "lowercase-alphanumeric",
      count: 10,
    });
    for (const id of result.ids) {
      expect(id).toMatch(/^[a-z0-9]+$/);
    }
  });

  it("size: 8 and size: 64 succeed", async () => {
    const small = await callNanoIdTool({ size: 8 });
    expect(small.ids[0]).toHaveLength(8);
    const large = await callNanoIdTool({ size: 64 });
    expect(large.ids[0]).toHaveLength(64);
  });

  it("size: 7 and size: 65 are rejected as validation errors", () => {
    expect(nanoIdSchema.safeParse({ size: 7 }).success).toBe(false);
    expect(nanoIdSchema.safeParse({ size: 65 }).success).toBe(false);
  });

  it("count: 100 returns 100 distinct ids", async () => {
    const result = await callNanoIdTool({ count: 100 });
    expect(result.ids).toHaveLength(100);
    expect(new Set(result.ids).size).toBe(100);
  });

  it("count: 0 and count: 101 are rejected as validation errors, not clamped", () => {
    expect(nanoIdSchema.safeParse({ count: 0 }).success).toBe(false);
    expect(nanoIdSchema.safeParse({ count: 101 }).success).toBe(false);
  });

  it("returns an array for count: 1", async () => {
    const result = await callNanoIdTool({ count: 1 });
    expect(Array.isArray(result.ids)).toBe(true);
  });
});
