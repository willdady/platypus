// @vitest-environment node
import { describe, it, expect } from "vitest";

import { parseEnv, serverBackendUrl } from "./env";

describe("parseEnv", () => {
  it("accepts a BACKEND_URL on its own", () => {
    expect(parseEnv({ BACKEND_URL: "http://localhost:4001" })).toEqual({
      BACKEND_URL: "http://localhost:4001",
      INTERNAL_BACKEND_URL: undefined,
    });
  });

  it("accepts an INTERNAL_BACKEND_URL beside it", () => {
    expect(
      parseEnv({
        BACKEND_URL: "https://chat.example.com/api",
        INTERNAL_BACKEND_URL: "http://backend:4000",
      }).INTERNAL_BACKEND_URL,
    ).toBe("http://backend:4000");
  });

  it("refuses a missing BACKEND_URL, naming it", () => {
    expect(() => parseEnv({})).toThrow(/BACKEND_URL/);
  });

  it("refuses an empty BACKEND_URL, which would make every request relative", () => {
    expect(() => parseEnv({ BACKEND_URL: "" })).toThrow(/BACKEND_URL/);
  });

  it("refuses a BACKEND_URL that is not an absolute URL", () => {
    expect(() => parseEnv({ BACKEND_URL: "localhost:4001" })).toThrow(
      /BACKEND_URL/,
    );
  });

  it("refuses a malformed INTERNAL_BACKEND_URL", () => {
    expect(() =>
      parseEnv({
        BACKEND_URL: "http://localhost:4001",
        INTERNAL_BACKEND_URL: "backend",
      }),
    ).toThrow(/INTERNAL_BACKEND_URL/);
  });

  it("treats an empty INTERNAL_BACKEND_URL as unset", () => {
    expect(
      parseEnv({
        BACKEND_URL: "http://localhost:4001",
        INTERNAL_BACKEND_URL: "",
      }).INTERNAL_BACKEND_URL,
    ).toBeUndefined();
  });
});

describe("serverBackendUrl", () => {
  it("prefers the internal URL for server-side requests", () => {
    expect(
      serverBackendUrl({
        BACKEND_URL: "https://chat.example.com/api",
        INTERNAL_BACKEND_URL: "http://backend:4000",
      }),
    ).toBe("http://backend:4000");
  });

  it("falls back to BACKEND_URL outside Docker", () => {
    expect(serverBackendUrl({ BACKEND_URL: "http://localhost:4001" })).toBe(
      "http://localhost:4001",
    );
  });
});
