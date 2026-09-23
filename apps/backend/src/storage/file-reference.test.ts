import { describe, it, expect, afterEach } from "vitest";
import {
  canonicalStorageKeyFromUrl,
  decodeDataUrl,
  isUnresolvedReference,
  resolvableStorageKeyFromUrl,
  servedUrlForKey,
  storageReferenceUrl,
} from "./file-reference.ts";

const KEY = "org-1/ws-1/chat-1/msg-1/0-abc12345.txt";

describe("file reference", () => {
  afterEach(() => {
    delete process.env.STORAGE_PUBLIC_URL;
  });

  describe("servedUrlForKey", () => {
    it("serves through /files/ when no public URL is configured", () => {
      expect(servedUrlForKey(KEY, "http://localhost:4000")).toBe(
        `http://localhost:4000/files/${KEY}`,
      );
    });

    it("serves from the public base when one is configured", () => {
      process.env.STORAGE_PUBLIC_URL = "https://cdn.example.com";
      expect(servedUrlForKey(KEY, "http://localhost:4000")).toBe(
        `https://cdn.example.com/${KEY}`,
      );
    });

    it("does not double the separator on a trailing slash", () => {
      process.env.STORAGE_PUBLIC_URL = "https://cdn.example.com/";
      expect(servedUrlForKey(KEY, "http://localhost:4000")).toBe(
        `https://cdn.example.com/${KEY}`,
      );
    });
  });

  describe("resolvableStorageKeyFromUrl", () => {
    const origin = "http://localhost:4000";

    it("reads the canonical form", () => {
      expect(
        resolvableStorageKeyFromUrl(storageReferenceUrl(KEY), origin),
      ).toEqual({ key: KEY, valid: true });
    });

    it("reads this deployment's own /files/ form", () => {
      expect(
        resolvableStorageKeyFromUrl(`${origin}/files/${KEY}`, origin),
      ).toEqual({ key: KEY, valid: true });
    });

    // Issue #839: the form a client replays on a deployment with a CDN.
    it("reads the public form", () => {
      process.env.STORAGE_PUBLIC_URL = "https://cdn.example.com";
      expect(
        resolvableStorageKeyFromUrl(`https://cdn.example.com/${KEY}`, origin),
      ).toEqual({ key: KEY, valid: true });
    });

    /**
     * A client can put any URL on a part. A `/files/` path under somebody
     * else's host names nothing this deployment served, so it stays the
     * external URL it claims to be rather than becoming a read of our own
     * store.
     */
    it("ignores a /files/ URL under a host this deployment does not serve", () => {
      expect(
        resolvableStorageKeyFromUrl(
          `https://attacker.example.com/x/files/${KEY}`,
          origin,
        ),
      ).toBeUndefined();
    });

    it("returns undefined for inline content and external URLs", () => {
      expect(
        resolvableStorageKeyFromUrl("data:text/plain;base64,aGk=", origin),
      ).toBeUndefined();
      expect(
        resolvableStorageKeyFromUrl("https://example.com/report.pdf", origin),
      ).toBeUndefined();
    });

    it("separates 'no key here' from 'a key we refuse'", () => {
      expect(
        resolvableStorageKeyFromUrl(`${origin}/files/../secret`, origin),
      ).toEqual({ key: "../secret", valid: false });
    });
  });

  describe("canonicalStorageKeyFromUrl", () => {
    it("answers only for the canonical form", () => {
      expect(canonicalStorageKeyFromUrl(storageReferenceUrl(KEY))).toBe(KEY);
      expect(
        canonicalStorageKeyFromUrl(`http://localhost:4000/files/${KEY}`),
      ).toBeUndefined();
    });
  });

  describe("isUnresolvedReference", () => {
    it("is true for a canonical reference and a missing URL only", () => {
      expect(isUnresolvedReference(storageReferenceUrl(KEY))).toBe(true);
      expect(isUnresolvedReference("")).toBe(true);
      expect(isUnresolvedReference(`https://cdn.example.com/${KEY}`)).toBe(
        false,
      );
      expect(isUnresolvedReference("data:text/plain;base64,aGk=")).toBe(false);
    });
  });

  describe("decodeDataUrl", () => {
    it("decodes a base64 body", () => {
      const decoded = decodeDataUrl("data:text/plain;base64,aGVsbG8=");
      expect(decoded?.mediaType).toBe("text/plain");
      expect(new TextDecoder().decode(decoded!.bytes)).toBe("hello");
    });

    // The three shapes the second, stricter parser used to refuse (issue #839).
    it("reads an omitted media type as application/octet-stream", () => {
      const decoded = decodeDataUrl("data:;base64,aGVsbG8=");
      expect(decoded?.mediaType).toBe("application/octet-stream");
      expect(new TextDecoder().decode(decoded!.bytes)).toBe("hello");
    });

    it("decodes a URL-encoded body", () => {
      const decoded = decodeDataUrl("data:text/plain,hello%20world");
      expect(decoded?.mediaType).toBe("text/plain");
      expect(new TextDecoder().decode(decoded!.bytes)).toBe("hello world");
    });

    it("accepts a body split across lines", () => {
      const decoded = decodeDataUrl("data:text/plain;base64,aGVs\nbG8=");
      expect(new TextDecoder().decode(decoded!.bytes)).toBe("hello");
    });

    it("returns null for anything that is not a data URL", () => {
      expect(decodeDataUrl("")).toBeNull();
      expect(decodeDataUrl(storageReferenceUrl(KEY))).toBeNull();
      expect(decodeDataUrl("https://example.com/x.png")).toBeNull();
    });
  });
});
