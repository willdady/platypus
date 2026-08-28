import crypto from "node:crypto";
import type { PlatypusUIMessage } from "../types.ts";
import type { FileExtractionContext } from "./types.ts";
import { getStorage } from "./index.ts";
import { logger } from "../logger.ts";
import {
  assertValidStorageKey,
  chatStorageKeyPrefix,
  isKeyUnderChat,
  isValidStorageKey,
  type ChatKeyScope,
} from "./keys.ts";

/**
 * Storage URL prefix used to identify storage references.
 */
export const STORAGE_URL_PREFIX = "storage://";

/**
 * Extract the file extension from a MIME type.
 */
function getExtensionFromMimeType(mimeType: string): string {
  const extensions: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "image/bmp": "bmp",
    "image/tiff": "tiff",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/ogg": "ogg",
    "application/pdf": "pdf",
    "application/json": "json",
    "text/plain": "txt",
    "text/csv": "csv",
  };
  return extensions[mimeType] || "bin";
}

/**
 * Generate a storage key for a file.
 * Format: {orgId}/{workspaceId}/{chatId}/{messageId}/{partIndex}-{hash8}.{ext}
 *
 * `messageId` is the id the client put on the message, so the composed key is
 * checked before it is returned: without that, a message id of `../../x` writes
 * the file outside its own Chat and Workspace prefix — the prefix `/files/*`
 * reads back to authorize. Throws rather than repairing the id, so the file is
 * not quietly filed under a key that does not name where it came from; the
 * caller already treats a failure here as "leave the data URL alone".
 */
function generateStorageKey(
  context: FileExtractionContext,
  partIndex: number,
  contentHash: string,
  extension: string,
): string {
  const hash8 = contentHash.slice(0, 8);
  const messageId = context.messageId || "unknown";
  const key = `${chatStorageKeyPrefix(context)}${messageId}/${partIndex}-${hash8}.${extension}`;
  assertValidStorageKey(key);
  return key;
}

/**
 * Compute SHA-256 hash of binary content and return as hex string.
 */
function hashContent(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Parse a data URL and extract its components.
 * Returns null if not a valid data URL.
 */
function parseDataUrl(
  url: string,
): { mimeType: string; base64Data: string } | null {
  const match = url.match(/^data:([^;,]+)(;base64)?,(.+)$/);
  if (!match) {
    return null;
  }

  const [, mimeType, , base64Data] = match;
  if (!match[2]) {
    // Not base64 encoded - we don't support URL-encoded data
    return null;
  }

  return { mimeType, base64Data };
}

/**
 * Extract files from messages, store them via the storage backend,
 * and replace data URLs with storage:// URLs.
 *
 * On storage failure, leaves the data URL as-is and logs the error.
 *
 * @param messages - Array of chat messages with parts
 * @param context - Context for generating storage keys (org, workspace, chat IDs)
 * @returns Modified messages with data URLs replaced by storage:// URLs
 */
export async function extractFiles(
  messages: PlatypusUIMessage[],
  context: FileExtractionContext,
): Promise<PlatypusUIMessage[]> {
  const storage = getStorage();

  const processedMessages = await Promise.all(
    messages.map(async (message, messageIndex) => {
      if (!message.parts || !Array.isArray(message.parts)) {
        return message;
      }

      const processedParts = await Promise.all(
        message.parts.map(async (part, partIndex) => {
          // Check if this is a file part with a data URL
          if (
            part.type !== "file" ||
            !("url" in part) ||
            typeof part.url !== "string"
          ) {
            return part;
          }

          const url = part.url;
          if (!url.startsWith("data:")) {
            return part;
          }

          const parsed = parseDataUrl(url);
          if (!parsed) {
            return part;
          }

          try {
            const { mimeType, base64Data } = parsed;
            const buffer = Buffer.from(base64Data, "base64");
            const contentHash = hashContent(buffer);
            const extension = getExtensionFromMimeType(mimeType);
            const key = generateStorageKey(
              { ...context, messageId: message.id },
              partIndex,
              contentHash,
              extension,
            );

            await storage.put(key, buffer, mimeType);

            // Replace the data URL with storage:// URL
            return {
              ...part,
              url: `${STORAGE_URL_PREFIX}${key}`,
            };
          } catch (error) {
            logger.error(
              { error, messageIndex, partIndex, context },
              "Failed to store file, leaving data URL as-is",
            );
            return part;
          }
        }),
      );

      return {
        ...message,
        parts: processedParts,
      };
    }),
  );

  return processedMessages;
}

/**
 * Rewrite storage:// URLs to HTTP URLs for serving.
 *
 * If STORAGE_PUBLIC_URL is set, URLs are rewritten to that base.
 * Otherwise, URLs are rewritten to the /files/{key} endpoint.
 *
 * @param messages - Array of chat messages with parts
 * @param baseUrl - The base URL of the backend server
 * @returns Modified messages with storage:// URLs replaced by HTTP URLs
 */
export function rewriteStorageUrls(
  messages: PlatypusUIMessage[],
  baseUrl: string,
): PlatypusUIMessage[] {
  const publicUrl = process.env.STORAGE_PUBLIC_URL;
  const filesBaseUrl = publicUrl || `${baseUrl}/files`;

  return messages.map((message) => {
    if (!message.parts || !Array.isArray(message.parts)) {
      return message;
    }

    const processedParts = message.parts.map((part) => {
      if (
        part.type !== "file" ||
        !("url" in part) ||
        typeof part.url !== "string"
      ) {
        return part;
      }

      const url = part.url;
      if (!url.startsWith(STORAGE_URL_PREFIX)) {
        return part;
      }

      const key = url.slice(STORAGE_URL_PREFIX.length);
      return {
        ...part,
        url: `${filesBaseUrl}/${key}`,
      };
    });

    return {
      ...message,
      parts: processedParts,
    };
  });
}

/**
 * Extract all storage keys from messages.
 * Useful for cleanup operations (e.g., when deleting a chat).
 *
 * Because a Chat resubmits its full history every turn, and the read path
 * rewrites `storage://` URLs to HTTP URLs, stored rows carry either form:
 * - `storage://<key>` (the canonical form)
 * - `<filesBase>/<key>` (the HTTP form the client returns on later turns, via
 *   `rewriteStorageUrls`)
 *
 * Both forms must be recognised so cleanup never orphans a file. The HTTP match
 * is deliberately looser than `inlineFileUrls`, which anchors on the request's
 * own origin: a deployment whose origin has changed still has rows carrying the
 * old one, and failing to recognise those would leak files forever.
 *
 * The cost of that tolerance is that the key here is only what the client
 * claimed. These keys therefore name candidates, not property — a caller that
 * deletes must filter them with `isKeyUnderChat`, as {@link deleteFiles} does.
 *
 * @param messages - Array of chat messages
 * @returns Array of storage keys found in the messages
 */
export function extractStorageKeys(messages: PlatypusUIMessage[]): string[] {
  const keys: string[] = [];

  for (const message of messages) {
    if (!message.parts || !Array.isArray(message.parts)) {
      continue;
    }

    for (const part of message.parts) {
      if (
        part.type !== "file" ||
        !("url" in part) ||
        typeof part.url !== "string"
      ) {
        continue;
      }

      const key = storageKeyFromUrl(part.url);
      if (key) {
        keys.push(key);
      }
    }
  }

  return keys;
}

/**
 * Extract the storage key from a file part URL, accepting both stored forms:
 * `storage://<key>`, or the HTTP form `<filesBase>/<key>` that
 * `rewriteStorageUrls` produces. Returns undefined when the URL is neither.
 */
function storageKeyFromUrl(url: string): string | undefined {
  const key = rawStorageKeyFromUrl(url);

  // The URL came back from the client, so the key in it is untrusted. A key
  // Platypus never generated names nothing it stored, so callers treat it the
  // same as a URL that carried no key at all.
  if (key === undefined || !isValidStorageKey(key)) {
    return undefined;
  }

  return key;
}

/**
 * Slice the key out of each URL form `rewriteStorageUrls` can produce, without
 * judging it. Split out so {@link storageKeyFromUrl} has one place to validate.
 */
function rawStorageKeyFromUrl(url: string): string | undefined {
  if (url.startsWith(STORAGE_URL_PREFIX)) {
    return url.slice(STORAGE_URL_PREFIX.length);
  }

  // A data: URL is inline content, not a stored reference.
  if (url.startsWith("data:")) {
    return undefined;
  }

  // When STORAGE_PUBLIC_URL is set, `rewriteStorageUrls` writes
  // `{publicUrl}/{key}` (no `/files/` segment).
  const publicUrl = process.env.STORAGE_PUBLIC_URL;
  const normalizedPublicUrl = publicUrl?.replace(/\/+$/, "");
  if (normalizedPublicUrl && url.startsWith(`${normalizedPublicUrl}/`)) {
    return url.slice(normalizedPublicUrl.length + 1);
  }

  // Default rewrite form: `<baseUrl>/files/<key>`.
  const filesMarker = "/files/";
  const markerIndex = url.lastIndexOf(filesMarker);
  if (markerIndex !== -1) {
    return url.slice(markerIndex + filesMarker.length);
  }

  return undefined;
}

/**
 * Replace HTTP file URLs and storage:// URLs with inline data: URLs
 * so that `convertToModelMessages()` can access file content without
 * making HTTP requests (which would fail without session cookies).
 *
 * This is an ephemeral transformation — only used in-memory for the
 * `streamText()` call. The DB continues to store storage:// URLs.
 *
 * @param messages - Array of chat messages with parts
 * @param backendOrigin - The origin of the backend server (e.g. http://localhost:4000)
 * @returns Modified messages with file URLs replaced by data: URLs
 */
export async function inlineFileUrls(
  messages: PlatypusUIMessage[],
  backendOrigin: string,
): Promise<PlatypusUIMessage[]> {
  const storage = getStorage();
  const filesPrefix = `${backendOrigin}/files/`;

  return Promise.all(
    messages.map(async (message) => {
      if (!message.parts || !Array.isArray(message.parts)) {
        return message;
      }

      const processedParts = await Promise.all(
        message.parts.map(async (part) => {
          if (
            part.type !== "file" ||
            !("url" in part) ||
            typeof part.url !== "string"
          ) {
            return part;
          }

          const url = part.url;

          // Already a data URL — nothing to do
          if (url.startsWith("data:")) {
            return part;
          }

          // Extract the storage key from the URL
          let key: string | undefined;
          if (url.startsWith(filesPrefix)) {
            key = url.slice(filesPrefix.length);
          } else if (url.startsWith(STORAGE_URL_PREFIX)) {
            key = url.slice(STORAGE_URL_PREFIX.length);
          }

          if (!key) {
            return part;
          }

          // The client returned this URL to us, so the key is untrusted: a
          // traversal key here would otherwise read a host file and inline it
          // into the System prompt. `normalizeFileParts` announces the part as
          // unavailable, exactly as it does for a storage miss.
          if (!isValidStorageKey(key)) {
            logger.warn(
              { key },
              "Rejected invalid storage key during inlining",
            );
            return part;
          }

          try {
            const result = await storage.get(key);
            if (!result) {
              logger.warn({ key }, "File not found in storage during inlining");
              return part;
            }

            const dataUrl = `data:${result.contentType};base64,${result.data.toString("base64")}`;
            return { ...part, url: dataUrl };
          } catch (error) {
            logger.error(
              { error, key },
              "Failed to inline file URL, leaving as-is",
            );
            return part;
          }
        }),
      );

      return { ...message, parts: processedParts };
    }),
  );
}

/**
 * Delete all files associated with a chat's messages.
 * Best-effort operation - errors are logged but don't fail the operation.
 *
 * Only keys under this Chat's own prefix are deleted. The keys come out of
 * message parts, and a client can put any URL on a part, so an unfiltered
 * delete lets a user plant `…/files/{another org}/…` in a Chat they own and
 * destroy another tenant's files by deleting it. Reading a Chat is enough to
 * learn such a key: `rewriteStorageUrls` hands every reader HTTP URLs with the
 * keys in them, so without this filter read access to a Chat implies the power
 * to delete its files.
 *
 * @param messages - Array of chat messages
 * @param scope - The Chat being deleted, whose files these must be
 */
export async function deleteFiles(
  messages: PlatypusUIMessage[],
  scope: ChatKeyScope,
): Promise<void> {
  const keys = extractStorageKeys(messages).filter((key) =>
    isKeyUnderChat(key, scope),
  );
  if (keys.length === 0) {
    return;
  }

  const storage = getStorage();

  await Promise.all(
    keys.map(async (key) => {
      try {
        await storage.delete(key);
      } catch (error) {
        logger.error({ error, key }, "Failed to delete file from storage");
      }
    }),
  );

  logger.info({ count: keys.length }, "Deleted files from storage");
}
