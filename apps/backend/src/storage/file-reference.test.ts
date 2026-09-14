import { describe, it, expect, afterEach } from "vitest";
import {
  canonicalStorageKeyFromUrl,
  decodeDataUrl,
  isDataUrl,
  isUnresolvedReference,
  servedUrlForKey,
  storageKeyCandidateFromUrl,
  storageKeyFromUrl,
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

  describe("storageKeyFromUrl", () => {
    it("reads the canonical form", () => {
      expect(storageKeyFromUrl(storageReferenceUrl(KEY))).toBe(KEY);
    });

    it("reads the /files/ form", () => {
      expect(storageKeyFromUrl(`http://localhost:4000/files/${KEY}`)).toBe(KEY);
    });

    // Issue #839: the form a client replays on a deployment with a CDN.
    it("reads the public form", () => {
      process.env.STORAGE_PUBLIC_URL = "https://cdn.example.com";
      expect(storageKeyFromUrl(`https://cdn.example.com/${KEY}`)).toBe(KEY);
    });

    /**
     * The `/files/` match stays loose about the origin in front of it: rows
     * written before a deployment's origin changed still resolve, and dropping
     * that tolerance would orphan their files forever.
     */
    it("reads the /files/ form under an origin this deployment no longer has", () => {
      expect(
        storageKeyFromUrl(`https://old-host.example.com/files/${KEY}`),
      ).toBe(KEY);
    });

    it("returns undefined for inline content and external URLs", () => {
      expect(storageKeyFromUrl("data:text/plain;base64,aGk=")).toBeUndefined();
      expect(
        storageKeyFromUrl("https://example.com/report.pdf"),
      ).toBeUndefined();
    });

    it("returns undefined for a key Platypus could not have stored", () => {
      expect(
        storageKeyFromUrl("http://localhost:4000/files/../../etc/passwd"),
      ).toBeUndefined();
    });
  });

  describe("storageKeyCandidateFromUrl", () => {
    it("separates 'no key here' from 'a key we refuse'", () => {
      expect(
        storageKeyCandidateFromUrl("https://example.com/report.pdf"),
      ).toBeUndefined();
      expect(
        storageKeyCandidateFromUrl("http://localhost:4000/files/../secret"),
      ).toEqual({ key: "../secret", valid: false });
      expect(storageKeyCandidateFromUrl(storageReferenceUrl(KEY))).toEqual({
        key: KEY,
        valid: true,
      });
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

  describe("isDataUrl", () => {
    it("recognises inline content", () => {
      expect(isDataUrl("data:text/plain;base64,aGk=")).toBe(true);
      expect(isDataUrl(storageReferenceUrl(KEY))).toBe(false);
    });
  });
});
