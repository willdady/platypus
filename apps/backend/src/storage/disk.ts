import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { StorageBackend } from "./types.ts";
import { logger } from "../logger.ts";
import { ValidationError } from "../errors.ts";

/**
 * Disk-based storage backend that stores files on the local filesystem.
 * Each file is stored as binary content, with a .meta JSON sidecar file
 * containing the content type.
 */
export class DiskStorage implements StorageBackend {
  private basePath: string;

  /**
   * @param basePath - Directory where files will be stored (default: "./data/files")
   */
  constructor(
    basePath: string = process.env.STORAGE_DISK_PATH || "./data/files",
  ) {
    this.basePath = path.resolve(basePath);
  }

  /**
   * Get the full filesystem path for a storage key.
   *
   * Keys reaching a backend from a client are validated where they enter
   * Platypus (`storage/keys.ts`), which is the gate that also covers
   * `S3Storage`. This check is not merely a second copy of that one: the Agent
   * avatar path (`services/avatar.ts`) composes its own key and does not go
   * through that gate, so for the disk backend this is the only containment
   * guard it has. It is also the last point before a path reaches the
   * filesystem, and this is the one backend where leaving the root reads an
   * unrelated host file rather than missing an object.
   */
  private getFilePath(key: string): string {
    const filePath = path.resolve(this.basePath, key);
    // A trailing separator on the base stops a sibling root matching by prefix
    // (`/data/files` must not admit `/data/files_secret`).
    if (!filePath.startsWith(this.basePath + path.sep)) {
      throw new ValidationError("Invalid file key");
    }
    return filePath;
  }

  /**
   * Get the path to the metadata sidecar file.
   *
   * Derived from the resolved object path, never from the key: appending
   * `.meta` to the key before resolving lets the two paths disagree — a key
   * ending in `..` would resolve one directory up for the object and stay put
   * for the sidecar.
   */
  private getMetaPath(key: string): string {
    return `${this.getFilePath(key)}.meta`;
  }

  /**
   * Ensure the directory for a file exists.
   */
  private async ensureDir(filePath: string): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
  }

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    const filePath = this.getFilePath(key);
    const metaPath = this.getMetaPath(key);

    await this.ensureDir(filePath);

    // Write the binary file
    await fs.writeFile(filePath, data);

    // Write the metadata sidecar
    await fs.writeFile(metaPath, JSON.stringify({ contentType }));

    logger.debug(
      { key, contentType, size: data.length },
      "File stored to disk",
    );
  }

  async get(
    key: string,
  ): Promise<{ data: Buffer; contentType: string } | null> {
    const filePath = this.getFilePath(key);
    const metaPath = this.getMetaPath(key);

    try {
      // Read both files in parallel
      const [data, metaContent] = await Promise.all([
        fs.readFile(filePath),
        fs.readFile(metaPath, "utf-8"),
      ]);

      const meta = JSON.parse(metaContent) as { contentType: string };
      return { data, contentType: meta.contentType };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    const filePath = this.getFilePath(key);
    const metaPath = this.getMetaPath(key);

    // Delete both files, ignoring errors if they don't exist
    await Promise.all([
      fs.unlink(filePath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          logger.warn({ error, key }, "Error deleting file from disk");
        }
      }),
      fs.unlink(metaPath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          logger.warn({ error, key }, "Error deleting meta file from disk");
        }
      }),
    ]);

    logger.debug({ key }, "File deleted from disk");
  }
}
