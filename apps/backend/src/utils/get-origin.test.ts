import { describe, it, expect } from "vitest";
import { getOrigin } from "./get-origin.ts";

function makeContext(url: string, headers: Record<string, string> = {}): any {
  return {
    req: {
      url,
      header(name: string) {
        return headers[name.toLowerCase()];
      },
    },
  };
}

describe("getOrigin", () => {
  it("returns origin from request URL when no forwarded headers", () => {
    const c = makeContext("http://localhost:4000/files/abc");
    expect(getOrigin(c)).toBe("http://localhost:4000");
  });

  it("uses x-forwarded-proto and x-forwarded-host when both present", () => {
    const c = makeContext("http://localhost:4000/files/abc", {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "example.com",
    });
    expect(getOrigin(c)).toBe("https://example.com");
  });

  it("uses x-forwarded-proto with host header as fallback", () => {
    const c = makeContext("http://localhost:4000/files/abc", {
      "x-forwarded-proto": "https",
      host: "example.com:8443",
    });
    expect(getOrigin(c)).toBe("https://example.com:8443");
  });

  it("falls back to request URL when only x-forwarded-proto is set without host", () => {
    const c = makeContext("http://localhost:4000/files/abc", {
      "x-forwarded-proto": "https",
    });
    expect(getOrigin(c)).toBe("http://localhost:4000");
  });
});
