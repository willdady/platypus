import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getStorage, resetStorage } from "./index.ts";
import { DiskStorage } from "./disk.ts";
import { S3Storage } from "./s3.ts";

// Mock S3Storage so we don't need real AWS credentials
vi.mock("./s3.ts", () => {
  class MockS3Storage {
    put = vi.fn();
    get = vi.fn();
    delete = vi.fn();
  }
  return { S3Storage: MockS3Storage };
});

describe("Storage index", () => {
  beforeEach(() => {
    resetStorage();
    delete process.env.STORAGE_BACKEND;
  });

  afterEach(() => {
    resetStorage();
    delete process.env.STORAGE_BACKEND;
  });

  describe("getStorage", () => {
    it.each([
      ["unset", undefined, DiskStorage],
      ["'disk'", "disk", DiskStorage],
      ["'s3'", "s3", S3Storage],
      ["an unknown value", "invalid", DiskStorage],
    ])(
      "picks the backend for STORAGE_BACKEND %s",
      (_label, backend, expected) => {
        if (backend !== undefined) process.env.STORAGE_BACKEND = backend;
        expect(getStorage()).toBeInstanceOf(expected);
      },
    );

    it("should return the same singleton instance on subsequent calls", () => {
      const storage1 = getStorage();
      const storage2 = getStorage();
      expect(storage1).toBe(storage2);
    });
  });

  describe("resetStorage", () => {
    it("should clear the singleton so a new instance is created", () => {
      const storage1 = getStorage();
      resetStorage();
      const storage2 = getStorage();
      expect(storage1).not.toBe(storage2);
    });
  });
});
