import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import type { StorageBackend } from "./types.ts";
import { assertValidStoragePrefix } from "./keys.ts";
import { logger } from "../logger.ts";

/**
 * S3-compatible storage backend.
 * Works with AWS S3 and any S3-compatible service (MinIO, Cloudflare R2, etc.).
 */
export class S3Storage implements StorageBackend {
  private client: S3Client;
  private bucket: string;

  constructor() {
    const bucket = process.env.STORAGE_S3_BUCKET;
    const region = process.env.STORAGE_S3_REGION || "us-east-1";
    const endpoint = process.env.STORAGE_S3_ENDPOINT;
    const accessKeyId = process.env.STORAGE_S3_ACCESS_KEY_ID;
    const secretAccessKey = process.env.STORAGE_S3_SECRET_ACCESS_KEY;

    if (!bucket) {
      throw new Error(
        "STORAGE_S3_BUCKET environment variable is required for S3 storage",
      );
    }

    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        "STORAGE_S3_ACCESS_KEY_ID and STORAGE_S3_SECRET_ACCESS_KEY are required for S3 storage",
      );
    }

    this.bucket = bucket;
    this.client = new S3Client({
      region,
      endpoint,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
  }

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: contentType,
        Metadata: {
          "content-type": contentType,
        },
      }),
    );

    logger.debug({ key, contentType, size: data.length }, "File stored to S3");
  }

  async get(
    key: string,
  ): Promise<{ data: Buffer; contentType: string } | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );

      if (!response.Body) {
        return null;
      }

      // Convert the stream to a buffer
      const chunks: Uint8Array[] = [];
      for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
        chunks.push(chunk);
      }
      const data = Buffer.concat(chunks);

      // Get content type from response or metadata
      const contentType =
        response.ContentType ||
        response.Metadata?.["content-type"] ||
        "application/octet-stream";

      return { data, contentType };
    } catch (error) {
      const e = error as { name?: string; Code?: string };
      if (e.name === "NoSuchKey" || e.Code === "NoSuchKey") {
        return null;
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );

    logger.debug({ key }, "File deleted from S3");
  }

  async deletePrefix(prefix: string): Promise<void> {
    assertValidStoragePrefix(prefix);

    let continuationToken: string | undefined;
    let count = 0;
    do {
      // A page holds at most 1000 keys, which is also `DeleteObjects`' limit,
      // so each page is exactly one batch.
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          MaxKeys: 1000,
          ContinuationToken: continuationToken,
        }),
      );
      const objects = (page.Contents ?? []).flatMap(({ Key }) =>
        Key ? [{ Key }] : [],
      );

      if (objects.length > 0) {
        const result = await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: objects, Quiet: true },
          }),
        );
        for (const error of result.Errors ?? []) {
          logger.error(
            { key: error.Key, code: error.Code, message: error.Message },
            "Failed to delete object from S3",
          );
        }
        count += objects.length;
      }

      continuationToken = page.IsTruncated
        ? page.NextContinuationToken
        : undefined;
    } while (continuationToken);

    logger.debug({ prefix, count }, "Prefix deleted from S3");
  }
}
