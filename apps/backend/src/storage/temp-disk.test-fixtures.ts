import { afterAll, beforeEach } from "vitest";
import { mkdtempSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// why: getStorage() memoises on first use, so bind the dir during test collection.
export const useTempDiskStorage = (): { readonly dir: string } => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "platypus-storage-test-"));
  process.env.STORAGE_DISK_PATH = dir;
  beforeEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
  });
  afterAll(async () => {
    delete process.env.STORAGE_DISK_PATH;
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir };
};
