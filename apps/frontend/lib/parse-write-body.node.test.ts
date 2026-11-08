import { describe, it, expect } from "vitest";
import { z } from "zod";
import { parseCloneBody } from "./parse-write-body";

const schema = z.object({
  name: z.string().max(5),
  notes: z.string().max(3),
});

const refusal = "This Thing cannot be cloned.";

describe("parseCloneBody", () => {
  it("returns the body unchanged when the create accepts it", () => {
    const body = { name: "short", notes: "ok" };

    expect(parseCloneBody(schema, body, refusal)).toEqual({
      ok: true,
      data: body,
    });
  });

  it("keys a name issue to the name field so a dialog can show it there", () => {
    const parsed = parseCloneBody(
      schema,
      { name: "too long", notes: "ok" },
      refusal,
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.outcome.outcome).toBe("invalid");
    expect(parsed.outcome.message).toBe(refusal);
    expect(parsed.outcome.fieldErrors.name).toBe(
      "Too big: expected string to have <=5 characters",
    );
  });

  it("leaves a failure elsewhere under the entity's refusal message", () => {
    const parsed = parseCloneBody(
      schema,
      { name: "short", notes: "too long" },
      refusal,
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.outcome.outcome).toBe("invalid");
    expect(parsed.outcome.message).toBe(refusal);
    expect(parsed.outcome.fieldErrors.name).toBeUndefined();
    expect(parsed.outcome.fieldErrors.notes).toBeDefined();
  });

  it("keys nothing when an issue names no field, so the refusal shows", () => {
    const parsed = parseCloneBody(
      schema.strict(),
      { name: "too long", notes: "ok", extra: true },
      refusal,
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.outcome.message).toBe(refusal);
    expect(parsed.outcome.fieldErrors).toEqual({});
  });
});
