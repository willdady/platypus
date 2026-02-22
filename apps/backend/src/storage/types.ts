/**
 * Storage backend interface for file storage operations.
 * Implementations can store files on disk, S3, or other storage systems.
 */
export interface StorageBackend {
  /**
   * Store a file with the given key.
   * @param key - Unique identifier for the file (e.g., "orgId/workspaceId/chatId/messageId/partIndex-hash.ext")
   * @param data - Binary content of the file
   * @param contentType - MIME type of the file (e.g., "image/png")
   */
  put(key: string, data: Buffer, contentType: string): Promise<void>;

  /**
   * Retrieve a file by its key.
   * @param key - Unique identifier for the file
   * @returns The file data and content type, or null if not found
   */
  get(key: string): Promise<{ data: Buffer; contentType: string } | null>;

  /**
   * Delete a file by its key.
   * @param key - Unique identifier for the file
   */
  delete(key: string): Promise<void>;
}

/**
 * Context for file extraction operations.
 */
export interface FileExtractionContext {
  orgId: string;
  workspaceId: string;
  chatId: string;
  messageId?: string;
}
