import type { StorageBackend } from "./types.ts";
import { DiskStorage } from "./disk.ts";
import { S3Storage } from "./s3.ts";
import { env } from "../env.ts";

let storageInstance: StorageBackend | null = null;

export function getStorage(): StorageBackend {
  return (storageInstance ??=
    env().STORAGE_BACKEND === "s3" ? new S3Storage() : new DiskStorage());
}

export type { StorageBackend } from "./types.ts";
