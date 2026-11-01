import { describe, it, expect, vi, afterEach } from "vitest";
import { z } from "zod";
import { respond } from "./respond.ts";

const schema = z.object({ id: z.string(), scope: z.enum(["workspace"]) });

/** The smallest thing `respond` needs from a Hono context. */
const context = () => ({ json: vi.fn((body: unknown) => body) });

describe("respond", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sends a value that matches its schema", () => {
    const c = context();
    expect(
      respond(c as never, schema, { id: "a", scope: "workspace" }, 201),
    ).toEqual({ id: "a", scope: "workspace" });
    expect(c.json).toHaveBeenCalledWith({ id: "a", scope: "workspace" }, 201);
  });

  it("fails a test when the response drifts from its schema", () => {
    // The point of the helper: drop a field from a route and its test fails
    // here rather than the frontend finding out.
    expect(() => respond(context() as never, schema, { id: "a" })).toThrow(
      /Response does not match its schema/,
    );
  });

  it("sends the caller's value untouched, extra columns included", () => {
    const value = { id: "a", scope: "workspace", storedOnly: true } as const;
    const c = context();
    respond(c as never, schema, value);
    expect(c.json).toHaveBeenCalledWith(value);
  });

  it("does not validate outside tests", () => {
    vi.stubEnv("NODE_ENV", "production");
    const c = context();
    expect(respond(c as never, schema, { id: "a" })).toEqual({
      id: "a",
    });
  });
});
