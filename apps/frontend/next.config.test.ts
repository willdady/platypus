// @vitest-environment node
import { describe, it, expect } from "vitest";
import rootPackage from "../../package.json";
import nextConfig from "./next.config";

async function headerFor(name: string) {
  const rules = (await nextConfig.headers?.()) ?? [];
  const everyPage = rules.find((rule) => rule.source === "/:path*");
  return everyPage?.headers.find((header) => header.key === name)?.value;
}

describe("next.config", () => {
  it("doesn't advertise the framework", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });

  it("refuses to be framed by another site", async () => {
    expect(await headerFor("Content-Security-Policy")).toBe(
      "frame-ancestors 'self'",
    );
    expect(await headerFor("X-Frame-Options")).toBe("SAMEORIGIN");
  });

  it("stops MIME sniffing and keeps paths out of cross-origin referrers", async () => {
    expect(await headerFor("X-Content-Type-Options")).toBe("nosniff");
    expect(await headerFor("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
  });

  it("bakes the release version in at build, with no .env.local", () => {
    expect(nextConfig.env?.APP_VERSION).toBe(rootPackage.version);
  });
});
