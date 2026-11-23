import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { StorageBackend, StoredFileStream } from "./types.ts";
import { logger } from "../logger.ts";
import { ValidationError } from "../errors.ts";
import { assertValidStoragePrefix } from "./keys.ts";
import { env } from "../env.ts";

export class DiskStorage implements StorageBackend {
  private basePath: string;

  constructor(basePath: string = env().STORAGE_DISK_PATH) {
    this.basePath = path.resolve(basePath);
  }

  private getFilePath(key: string): string {
    const filePath = path.resolve(this.basePath, key);
    if (!filePath.startsWith(this.basePath + path.sep)) {
      throw new ValidationError("Invalid file key");
    }
    return filePath;
  }

  private getMetaPath(key: string): string {
    return `${this.getFilePath(key)}.meta`;
  }

  private async ensureDir(filePath: string): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
  }

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    const filePath = this.getFilePath(key);
    const metaPath = this.getMetaPath(key);

    await this.ensureDir(filePath);

    await fs.writeFile(filePath, data);

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

  async getStream(key: string): Promise<StoredFileStream | null> {
    const filePath = this.getFilePath(key);
    const metaPath = this.getMetaPath(key);

    try {
      const meta = JSON.parse(await fs.readFile(metaPath, "utf-8")) as {
        contentType: string;
      };
      const handle = await fs.open(filePath);
      try {
        const { size } = await handle.stat();
        // why: the stream closes the handle once it ends or is destroyed
        return {
          stream: handle.createReadStream(),
          contentType: meta.contentType,
          contentLength: size,
        };
      } catch (error) {
        await handle.close();
        throw error;
      }
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

  async deletePrefix(prefix: string): Promise<void> {
    assertValidStoragePrefix(prefix);
    await fs.rm(this.getFilePath(prefix), { recursive: true, force: true });

    logger.debug({ prefix }, "Prefix deleted from disk");
  }
}
