import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const loadBackends = async () => {
  const [disk, s3] = await Promise.all([
    import("./disk.ts"),
    import("./s3.ts"),
  ]);
  return { DiskStorage: disk.DiskStorage, S3Storage: s3.S3Storage };
};

describe("Storage index", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.STORAGE_BACKEND;
  });

  afterEach(() => {
    vi.resetModules();
    delete process.env.STORAGE_BACKEND;
    vi.unstubAllEnvs();
  });

  describe("getStorage", () => {
    it.each([
      ["unset", undefined, "DiskStorage"],
      ["'disk'", "disk", "DiskStorage"],
      ["'s3'", "s3", "S3Storage"],
    ] as const)(
      "picks the backend for STORAGE_BACKEND %s",
      async (_label, backend, expected) => {
        if (backend !== undefined) vi.stubEnv("STORAGE_BACKEND", backend);
        vi.stubEnv("STORAGE_S3_BUCKET", "bucket");
        vi.stubEnv("STORAGE_S3_ACCESS_KEY_ID", "key");
        vi.stubEnv("STORAGE_S3_SECRET_ACCESS_KEY", "secret");
        const [{ getStorage }, backends] = await Promise.all([
          import("./index.ts"),
          loadBackends(),
        ]);
        expect(getStorage()).toBeInstanceOf(backends[expected]);
      },
    );

    it("should return the same singleton instance on subsequent calls", async () => {
      const { getStorage } = await import("./index.ts");
      const storage1 = getStorage();
      const storage2 = getStorage();
      expect(storage1).toBe(storage2);
    });
  });
});
