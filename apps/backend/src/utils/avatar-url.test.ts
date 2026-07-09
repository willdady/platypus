import { describe, it, expect, afterEach } from "vitest";
import { avatarKeyToUrl } from "./avatar-url.ts";

describe("avatarKeyToUrl", () => {
  const originalEnv = process.env.STORAGE_PUBLIC_URL;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.STORAGE_PUBLIC_URL;
    } else {
      process.env.STORAGE_PUBLIC_URL = originalEnv;
    }
  });

  it("should return null when avatarKey is null", () => {
    expect(avatarKeyToUrl(null, "http://localhost:4000")).toBeNull();
  });

  it("should return null when avatarKey is undefined", () => {
    expect(avatarKeyToUrl(undefined, "http://localhost:4000")).toBeNull();
  });

  it("should return null when avatarKey is an empty string", () => {
    expect(avatarKeyToUrl("", "http://localhost:4000")).toBeNull();
  });

  it("should use STORAGE_PUBLIC_URL when set", () => {
    process.env.STORAGE_PUBLIC_URL = "https://cdn.example.com";
    expect(avatarKeyToUrl("avatars/abc.png", "http://localhost:4000")).toBe(
      "https://cdn.example.com/avatars/abc.png",
    );
  });

  it("should proxy through /files/ endpoint when STORAGE_PUBLIC_URL is not set", () => {
    delete process.env.STORAGE_PUBLIC_URL;
    expect(avatarKeyToUrl("avatars/abc.png", "http://localhost:4000")).toBe(
      "http://localhost:4000/files/avatars/abc.png",
    );
  });
});
