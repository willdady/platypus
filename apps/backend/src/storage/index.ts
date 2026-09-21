import type { StorageBackend } from "./types.ts";
import { DiskStorage } from "./disk.ts";
import { S3Storage } from "./s3.ts";
import { logger } from "../logger.ts";

let storageInstance: StorageBackend | null = null;

/**
 * The singleton storage backend, created on first call from `STORAGE_BACKEND`.
 * Anything other than `s3` is disk.
 *
 * An unrecognised value still says so: `self-hosting/production.mdx` tells
 * multi-replica operators to set this var, and a typo that silently serves
 * disk on one replica makes files written there invisible to the others.
 */
export function getStorage(): StorageBackend {
  const configured = process.env.STORAGE_BACKEND;
  if (configured && configured !== "disk" && configured !== "s3") {
    logger.warn(
      { STORAGE_BACKEND: configured },
      "Unrecognised STORAGE_BACKEND, falling back to disk",
    );
  }
  return (storageInstance ??=
    configured === "s3" ? new S3Storage() : new DiskStorage());
}

/**
 * Reset the storage instance (useful for testing).
 */
export function resetStorage(): void {
  storageInstance = null;
}

export type { StorageBackend } from "./types.ts";
