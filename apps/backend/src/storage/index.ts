import type { StorageBackend } from "./types.ts";
import { DiskStorage } from "./disk.ts";
import { S3Storage } from "./s3.ts";
import { logger } from "../logger.ts";

let storageInstance: StorageBackend | null = null;

/**
 * Get the storage backend type from environment variable.
 * Defaults to "disk" if not set.
 */
function getStorageBackendType(): "disk" | "s3" {
  const backend = process.env.STORAGE_BACKEND || "disk";
  if (backend !== "disk" && backend !== "s3") {
    logger.warn(
      `Invalid STORAGE_BACKEND value '${backend}', defaulting to 'disk'`,
    );
    return "disk";
  }
  return backend;
}

/**
 * Create a new storage backend instance based on environment configuration.
 */
function createStorageBackend(): StorageBackend {
  const type = getStorageBackendType();

  if (type === "s3") {
    logger.info("Using S3 storage backend");
    return new S3Storage();
  }

  logger.info("Using disk storage backend");
  return new DiskStorage();
}

/**
 * Get the singleton storage backend instance.
 * Creates the instance on first call based on STORAGE_BACKEND env var.
 */
export function getStorage(): StorageBackend {
  if (!storageInstance) {
    storageInstance = createStorageBackend();
  }
  return storageInstance;
}

/**
 * Reset the storage instance (useful for testing).
 */
export function resetStorage(): void {
  storageInstance = null;
}

export { DiskStorage } from "./disk.ts";
export { S3Storage } from "./s3.ts";
export type { StorageBackend, FileExtractionContext } from "./types.ts";
