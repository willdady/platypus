import { afterEach, describe, expect, it, vi } from "vitest";
import "./test-utils.ts";
import app from "./server.ts";

/**
 * The one authority the frontend reads to decide whether to offer Sign up
 * (#550, ADR-0019). It takes no session: it discloses nothing an anonymous
 * caller could not learn by attempting to register once.
 */
describe("GET /registration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports registration open when REQUIRE_INVITATION_TO_SIGN_UP is unset", async () => {
    vi.stubEnv("REQUIRE_INVITATION_TO_SIGN_UP", undefined);

    const res = await app.request("/registration");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ open: true });
  });

  it("reports registration closed when REQUIRE_INVITATION_TO_SIGN_UP is true", async () => {
    vi.stubEnv("REQUIRE_INVITATION_TO_SIGN_UP", "true");

    const res = await app.request("/registration");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ open: false });
  });
});
