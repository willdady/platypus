import { describe, it, expect } from "vitest";
import { isValidStorageKey, assertValidStorageKey } from "./keys.ts";
import { ValidationError } from "../errors.ts";

describe("storage keys", () => {
  describe("isValidStorageKey", () => {
    it("accepts the File part key shape", () => {
      expect(isValidStorageKey("org-1/ws-1/chat-1/msg-1/0-abc12345.png")).toBe(
        true,
      );
    });

    it("accepts the Agent avatar key shape", () => {
      expect(isValidStorageKey("agents/agent-1/avatar-V1StGX_R7.webp")).toBe(
        true,
      );
    });

    it("accepts a single-segment key", () => {
      expect(isValidStorageKey("file.png")).toBe(true);
    });

    it.each([
      ["empty", ""],
      ["parent segment", "../secret/creds.txt"],
      ["nested parent segment", "org-1/ws-1/../../../etc/passwd"],
      ["trailing parent segment", "org-1/ws-1/.."],
      ["current-dir segment", "org-1/./ws-1"],
      ["absolute", "/etc/passwd"],
      ["empty segment", "org-1//ws-1"],
      ["trailing slash", "org-1/ws-1/"],
      ["percent-encoded separator", "..%2f..%2fetc%2fpasswd"],
      ["percent-encoded dot", "%2e%2e/secret"],
      ["backslash separator", "..\\..\\windows\\win.ini"],
      ["NUL byte", "org-1/ws-1\0.png"],
      ["newline", "org-1/ws-1\n.png"],
      ["space", "org 1/ws-1.png"],
      ["tilde", "~/.ssh/id_rsa"],
    ])("rejects %s", (_label, key) => {
      expect(isValidStorageKey(key)).toBe(false);
    });

    it("rejects a key longer than the cap", () => {
      expect(isValidStorageKey("a".repeat(1025))).toBe(false);
    });
  });

  describe("assertValidStorageKey", () => {
    it("passes a valid key", () => {
      expect(() =>
        assertValidStorageKey("org-1/ws-1/chat-1/msg-1/0-abc12345.png"),
      ).not.toThrow();
    });

    it("throws ValidationError so the seam answers 400", () => {
      expect(() => assertValidStorageKey("../secret")).toThrow(ValidationError);
    });
  });
});
