import type { Readable } from "node:stream";

export interface StoredFileStream {
  stream: Readable;
  contentType: string;
  contentLength: number;
}

export interface StorageBackend {
  put(key: string, data: Buffer, contentType: string): Promise<void>;

  get(key: string): Promise<{ data: Buffer; contentType: string } | null>;

  getStream(key: string): Promise<StoredFileStream | null>;

  delete(key: string): Promise<void>;

  deletePrefix(prefix: string): Promise<void>;
}

export interface FileExtractionContext {
  orgId: string;
  workspaceId: string;
  chatId: string;
}
