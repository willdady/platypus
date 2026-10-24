import type { StorageBackend } from "./types.ts";
import { DiskStorage } from "./disk.ts";
import { S3Storage } from "./s3.ts";
import { env } from "../env.ts";

let storageInstance: StorageBackend | null = null;

/**
 * The singleton storage backend, created on first call from `STORAGE_BACKEND`.
 * An unrecognised value stops the backend at boot (`env.ts`).
 */
export function getStorage(): StorageBackend {
  return (storageInstance ??=
    env().STORAGE_BACKEND === "s3" ? new S3Storage() : new DiskStorage());
}

/**
 * Reset the storage instance (useful for testing).
 */
export function resetStorage(): void {
  storageInstance = null;
}

export type { StorageBackend } from "./types.ts";
