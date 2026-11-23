import { afterEach, describe, expect, it, vi } from "vitest";
import "./test-utils.ts";
import app from "./server.ts";

describe("GET /sign-up", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const signUpAvailability = async (): Promise<unknown> => {
    const res = await app.request("/sign-up");
    expect(res.status).toBe(200);
    return res.json();
  };

  it.each([undefined, ""])(
    "reports sign-up closed when REQUIRE_INVITATION_TO_SIGN_UP is %j",
    async (value) => {
      vi.stubEnv("REQUIRE_INVITATION_TO_SIGN_UP", value);

      expect(await signUpAvailability()).toEqual({ open: false });
    },
  );

  it.each(["true", "1", " TRUE "])(
    "reports sign-up closed when REQUIRE_INVITATION_TO_SIGN_UP is %j",
    async (value) => {
      vi.stubEnv("REQUIRE_INVITATION_TO_SIGN_UP", value);

      expect(await signUpAvailability()).toEqual({ open: false });
    },
  );

  it.each(["false", "0"])(
    "reports sign-up open when REQUIRE_INVITATION_TO_SIGN_UP is %j",
    async (value) => {
      vi.stubEnv("REQUIRE_INVITATION_TO_SIGN_UP", value);

      expect(await signUpAvailability()).toEqual({ open: true });
    },
  );
});
