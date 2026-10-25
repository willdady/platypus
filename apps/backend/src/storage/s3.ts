import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";
import type { StorageBackend, StoredFileStream } from "./types.ts";
import { assertValidStoragePrefix } from "./keys.ts";
import { servedFileHeaders } from "./response-headers.ts";
import { logger } from "../logger.ts";
import { env } from "../env.ts";

const S3_CONNECTION_TIMEOUT_MS = 5_000;
const S3_REQUEST_TIMEOUT_MS = 30_000;

/** The object's content type, from the response or its metadata. */
function contentTypeOf(response: GetObjectCommandOutput): string {
  return (
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty string falls back too
    response.ContentType ||
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty string falls back too
    response.Metadata?.["content-type"] ||
    "application/octet-stream"
  );
}

/**
 * S3-compatible storage backend.
 * Works with AWS S3 and any S3-compatible service (MinIO, Cloudflare R2, etc.).
 */
export class S3Storage implements StorageBackend {
  private client: S3Client;
  private bucket: string;

  constructor() {
    const {
      STORAGE_S3_BUCKET: bucket,
      STORAGE_S3_REGION: region,
      STORAGE_S3_ENDPOINT: endpoint,
      STORAGE_S3_ACCESS_KEY_ID: accessKeyId,
      STORAGE_S3_SECRET_ACCESS_KEY: secretAccessKey,
    } = env();

    if (!bucket) {
      throw new Error(
        "STORAGE_S3_BUCKET environment variable is required for S3 storage",
      );
    }

    this.bucket = bucket;
    this.client = new S3Client({
      region,
      endpoint,
      // Without keys the SDK's default chain applies: env vars, shared
      // config, IRSA, task role, instance profile. `env.ts` refuses one alone.
      ...(accessKeyId &&
        secretAccessKey && { credentials: { accessKeyId, secretAccessKey } }),
      requestHandler: {
        connectionTimeout: S3_CONNECTION_TIMEOUT_MS,
        requestTimeout: S3_REQUEST_TIMEOUT_MS,
        // Otherwise the SDK only logs a warning and lets the request hang.
        throwOnRequestTimeout: true,
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
        // With STORAGE_PUBLIC_URL the bucket serves the file itself, so the
        // disposition `/files/*` would send has to be stored on the object.
        // A CSP cannot be; the deployment docs ask the bucket or CDN for it.
        ContentDisposition:
          servedFileHeaders(contentType)["Content-Disposition"],
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

      const contentType = contentTypeOf(response);

      return { data, contentType };
    } catch (error) {
      const e = error as { name?: string; Code?: string };
      if (e.name === "NoSuchKey" || e.Code === "NoSuchKey") {
        return null;
      }
      throw error;
    }
  }

  async getStream(key: string): Promise<StoredFileStream | null> {
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
      // In Node the SDK's body is an `IncomingMessage`.
      const stream = response.Body as Readable;
      if (response.ContentLength === undefined) {
        stream.destroy();
        throw new Error(`S3 returned no Content-Length for ${key}`);
      }

      const contentType = contentTypeOf(response);

      return {
        stream,
        contentType,
        contentLength: response.ContentLength,
      };
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
