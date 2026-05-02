import { describe, it, expect } from "vitest";
import { z } from "zod";

// Regression test for https://github.com/willdady/platypus/issues (zod@4.4.x broke Bedrock streaming)
//
// @ai-sdk/amazon-bedrock defines BedrockToolUseSchema with `input: z.unknown()`.
// Bedrock's contentBlockStart streaming event sends toolUse without an `input`
// field (it arrives later via contentBlockDelta). z.unknown() must accept a
// missing key or the SDK throws a TypeValidationError mid-stream.
//
// If this test fails after a `zod` version bump, pin zod back to ^4.3.6 until
// the SDK ships a fix (e.g. `input: z.unknown().optional()`).
describe("Bedrock SDK / Zod compatibility", () => {
  it("z.unknown() accepts a missing key", () => {
    const schema = z.object({ input: z.unknown() });
    expect(() => schema.parse({})).not.toThrow();
  });
});
