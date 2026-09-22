import { afterEach, describe, expect, it, vi } from "vitest";
import "./test-utils.ts";
import app from "./server.ts";

/**
 * The one authority the frontend reads to decide whether to offer Sign up
 * (#550, ADR-0019). It takes no session: it discloses nothing an anonymous
 * caller could not learn by attempting to sign up once. How
 * `REQUIRE_INVITATION_TO_SIGN_UP` is parsed is pinned here, at the seam a
 * caller sees, rather than against the module that parses it.
 */
describe("GET /sign-up", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const signUpAvailability = async (): Promise<unknown> => {
    const res = await app.request("/sign-up");
    expect(res.status).toBe(200);
    return res.json();
  };

  it("reports sign-up open when REQUIRE_INVITATION_TO_SIGN_UP is unset", async () => {
    vi.stubEnv("REQUIRE_INVITATION_TO_SIGN_UP", undefined);

    expect(await signUpAvailability()).toEqual({ open: true });
  });

  it.each(["true", "1", " TRUE "])(
    "reports sign-up closed when REQUIRE_INVITATION_TO_SIGN_UP is %j",
    async (value) => {
      vi.stubEnv("REQUIRE_INVITATION_TO_SIGN_UP", value);

      expect(await signUpAvailability()).toEqual({ open: false });
    },
  );

  it.each(["false", "0", ""])(
    "reports sign-up open when REQUIRE_INVITATION_TO_SIGN_UP is %j",
    async (value) => {
      vi.stubEnv("REQUIRE_INVITATION_TO_SIGN_UP", value);

      expect(await signUpAvailability()).toEqual({ open: true });
    },
  );
});
