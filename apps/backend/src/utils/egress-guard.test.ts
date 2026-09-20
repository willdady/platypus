import { describe, it, expect, vi } from "vitest";
import { checkEgress, EGRESS_BLOCKED_MESSAGE } from "./egress-guard.ts";

// Every test injects `resolve`, so nothing here touches real DNS. Literal IP
// hosts skip resolution entirely and pass no resolver at all.
const resolvesTo =
  (...addresses: string[]) =>
  () =>
    Promise.resolve(addresses);

const expectBlocked = (verdict: Awaited<ReturnType<typeof checkEgress>>) => {
  expect(verdict.allowed).toBe(false);
  if (verdict.allowed) throw new Error("expected a blocked verdict");
  return verdict.reason;
};

describe("checkEgress", () => {
  describe("addresses blocked regardless of the private-network setting", () => {
    it.each([
      ["loopback", "http://127.0.0.1/"],
      ["loopback, high octet", "http://127.99.1.2/"],
      ["this-host range reaching localhost", "http://0.0.0.0:5432/"],
      ["AWS/Azure/GCP metadata", "http://169.254.169.254/latest/meta-data/"],
      ["Alibaba metadata in carrier-grade NAT", "http://100.100.100.200/"],
      ["IPv6 loopback", "http://[::1]/"],
      ["IPv6 unspecified", "http://[::]/"],
      ["IPv6 link-local", "http://[fe80::1]/"],
    ])("blocks %s", async (_label, url) => {
      expectBlocked(await checkEgress(url, { allowPrivateNetworks: true }));
    });

    it("blocks an IPv4-mapped IPv6 literal in hex form", async () => {
      // isIP() calls this v6, so the v4 rules only see it once unwrapped.
      const reason = expectBlocked(
        await checkEgress("http://[::ffff:a9fe:a9fe]/", {
          allowPrivateNetworks: true,
        }),
      );
      expect(reason).toContain("link-local");
    });

    it("blocks an IPv4-mapped IPv6 literal in dotted form", async () => {
      expectBlocked(
        await checkEgress("http://[::ffff:169.254.169.254]/", {
          allowPrivateNetworks: true,
        }),
      );
    });

    it("blocks a link-local address carrying a zone id", async () => {
      // A resolver can hand back a scoped address; the zone scopes which
      // interface it sits on and must not hide it from the link-local rule.
      const reason = expectBlocked(
        await checkEgress("http://intranet.example.com/", {
          allowPrivateNetworks: true,
          resolve: resolvesTo("fe80::1%eth0"),
        }),
      );
      expect(reason).toContain("link-local");
    });

    it("blocks a hostname that resolves to the metadata service", async () => {
      const reason = expectBlocked(
        await checkEgress("http://metadata.google.internal/", {
          allowPrivateNetworks: true,
          resolve: resolvesTo("169.254.169.254"),
        }),
      );
      expect(reason).toContain("169.254.169.254");
    });

    it("blocks a public-looking hostname that resolves inward", async () => {
      expectBlocked(
        await checkEgress("http://169-254-169-254.nip.io/", {
          allowPrivateNetworks: true,
          resolve: resolvesTo("169.254.169.254"),
        }),
      );
    });

    it("blocks when only one of several records is internal", async () => {
      expectBlocked(
        await checkEgress("http://mixed.example.com/", {
          allowPrivateNetworks: true,
          resolve: resolvesTo("93.184.216.34", "127.0.0.1"),
        }),
      );
    });
  });

  describe("numeric encodings normalised by URL parsing", () => {
    // These need no guard logic — WHATWG URL rewrites the host before we look.
    it.each([
      ["decimal", "http://2852039166/", "169.254.169.254"],
      ["octal", "http://0251.0376.0251.0376/", "169.254.169.254"],
      ["hex", "http://0x7f000001/", "127.0.0.1"],
    ])("blocks %s-encoded IPv4", async (_label, url, expected) => {
      const reason = expectBlocked(
        await checkEgress(url, { allowPrivateNetworks: true }),
      );
      expect(reason).toContain(expected);
    });
  });

  describe("private networks", () => {
    it.each([
      "http://10.1.2.3/",
      "http://172.16.5.5/",
      "http://192.168.1.1/",
      "http://[fc00::1]/",
    ])("allows %s by default", async (url) => {
      expect(await checkEgress(url, { allowPrivateNetworks: true })).toEqual({
        allowed: true,
      });
    });

    it.each([
      "http://10.1.2.3/",
      "http://172.16.5.5/",
      "http://192.168.1.1/",
      "http://[fc00::1]/",
    ])("blocks %s when private networks are denied", async (url) => {
      expectBlocked(await checkEgress(url, { allowPrivateNetworks: false }));
    });

    it("allows a hostname resolving into RFC-1918 by default", async () => {
      // The intranet case the inverted posture exists for.
      expect(
        await checkEgress("https://wiki.internal/page", {
          allowPrivateNetworks: true,
          resolve: resolvesTo("10.4.5.6"),
        }),
      ).toEqual({ allowed: true });
    });

    it("still blocks metadata when private networks are allowed", async () => {
      expectBlocked(
        await checkEgress("http://169.254.169.254/", {
          allowPrivateNetworks: true,
        }),
      );
    });

    it("reads the default from EGRESS_ALLOW_PRIVATE_NETWORKS", async () => {
      const original = process.env.EGRESS_ALLOW_PRIVATE_NETWORKS;
      try {
        process.env.EGRESS_ALLOW_PRIVATE_NETWORKS = "false";
        expectBlocked(await checkEgress("http://10.1.2.3/"));

        process.env.EGRESS_ALLOW_PRIVATE_NETWORKS = "0";
        expectBlocked(await checkEgress("http://10.1.2.3/"));

        delete process.env.EGRESS_ALLOW_PRIVATE_NETWORKS;
        expect(await checkEgress("http://10.1.2.3/")).toEqual({
          allowed: true,
        });
      } finally {
        if (original === undefined) {
          delete process.env.EGRESS_ALLOW_PRIVATE_NETWORKS;
        } else {
          process.env.EGRESS_ALLOW_PRIVATE_NETWORKS = original;
        }
      }
    });
  });

  describe("schemes", () => {
    it.each([
      "file:///etc/passwd",
      "ftp://example.com/x",
      "gopher://example.com/",
      "data:text/plain,hello",
    ])("blocks %s", async (url) => {
      const reason = expectBlocked(
        await checkEgress(url, { allowPrivateNetworks: true }),
      );
      expect(reason).toContain("is not http or https");
    });

    it.each(["http://example.com/", "https://example.com/"])(
      "allows %s",
      async (url) => {
        expect(
          await checkEgress(url, {
            allowPrivateNetworks: true,
            resolve: resolvesTo("93.184.216.34"),
          }),
        ).toEqual({ allowed: true });
      },
    );
  });

  describe("failure modes", () => {
    it("blocks a malformed URL", async () => {
      const reason = expectBlocked(
        await checkEgress("not a url", { allowPrivateNetworks: true }),
      );
      expect(reason).toContain("not a valid URL");
    });

    it("fails closed when resolution throws", async () => {
      const reason = expectBlocked(
        await checkEgress("http://nx.example.com/", {
          allowPrivateNetworks: true,
          resolve: () => Promise.reject(new Error("ENOTFOUND")),
        }),
      );
      expect(reason).toContain("could not be resolved");
    });

    it("fails closed when resolution yields nothing", async () => {
      expectBlocked(
        await checkEgress("http://empty.example.com/", {
          allowPrivateNetworks: true,
          resolve: resolvesTo(),
        }),
      );
    });

    it("does not resolve a literal IP host", async () => {
      const resolve = vi.fn(resolvesTo("1.2.3.4"));
      await checkEgress("http://93.184.216.34/", {
        allowPrivateNetworks: true,
        resolve,
      });
      expect(resolve).not.toHaveBeenCalled();
    });
  });

  it("keeps the model-facing message uniform across causes", () => {
    // The reason string is for the server log. The model sees only this, so it
    // cannot tell "does not resolve" from "resolves somewhere blocked" and use
    // the tool to probe internal DNS.
    expect(EGRESS_BLOCKED_MESSAGE).not.toContain("resolve");
    expect(EGRESS_BLOCKED_MESSAGE).not.toContain("169.254");
  });
});
