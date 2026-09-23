import crypto from "node:crypto";
import type { PlatypusUIMessage } from "../types.ts";
import type { FileExtractionContext } from "./types.ts";
import { getStorage } from "./index.ts";
import { logger } from "../logger.ts";
import { ValidationError } from "../errors.ts";
import { assertValidStorageKey, chatStorageKeyPrefix } from "./keys.ts";
import {
  canonicalStorageKeyFromUrl,
  decodeDataUrl,
  resolvableStorageKeyFromUrl,
  servedUrlForKey,
  storageReferenceUrl,
} from "./file-reference.ts";

/**
 * The media types a File part may be stored under, each mapped to the
 * extension its storage key carries.
 *
 * This table is an allowlist, not a lookup with a fallback. The media type is
 * the client's — it comes out of the data URL — and it is persisted and then
 * sent straight back as `Content-Type` by `/files/*`. A type Platypus never
 * expects is therefore a document of the client's choosing served from the
 * deployment's own origin, `text/html` above all, so an unlisted type is
 * refused at store time rather than filed under a `.bin` key.
 *
 * `application/octet-stream` is listed because it is what a file arriving from
 * a paste buffer, or from an OS that declines to name a type, actually carries;
 * the file gate admits those on the filename. It is the only type that stores
 * as `.bin`.
 */
const STORABLE_MEDIA_TYPE_EXTENSIONS: Record<string, string> = {
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
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/octet-stream": "bin",
};

/**
 * The extension to file a storable media type under.
 *
 * Throws `ValidationError` on a type outside
 * {@link STORABLE_MEDIA_TYPE_EXTENSIONS}, the same way the storage-key
 * assertion does: the caller treats a failure as "leave the data URL alone",
 * so the part stays inline and nothing is written.
 */
function extensionForMediaType(mimeType: string): string {
  const extension = STORABLE_MEDIA_TYPE_EXTENSIONS[mimeType.toLowerCase()];
  if (!extension) {
    throw new ValidationError(`Unsupported file media type: ${mimeType}`);
  }
  return extension;
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
 * Extract files from messages, store them via the storage backend, and replace
 * inline data URLs with canonical storage references.
 *
 * On storage failure, leaves the data URL as-is and logs the error.
 *
 * @param messages - Array of chat messages with parts
 * @param context - Context for generating storage keys (org, workspace, chat IDs)
 * @returns Modified messages with data URLs replaced by storage references
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

          const parsed = decodeDataUrl(part.url);
          if (!parsed) {
            return part;
          }

          try {
            const { mediaType, bytes } = parsed;
            const buffer = Buffer.from(bytes);
            const contentHash = hashContent(buffer);
            const extension = extensionForMediaType(mediaType);
            const key = generateStorageKey(
              { ...context, messageId: message.id },
              partIndex,
              contentHash,
              extension,
            );

            await storage.put(key, buffer, mediaType);

            // Replace the data URL with a canonical storage reference
            return {
              ...part,
              url: storageReferenceUrl(key),
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
 * Rewrite canonical storage references to the URL a reader is served
 * ({@link servedUrlForKey}).
 *
 * @param messages - Array of chat messages with parts
 * @param baseUrl - The base URL of the backend server
 * @returns Modified messages with storage references replaced by served URLs
 */
export function rewriteStorageUrls(
  messages: PlatypusUIMessage[],
  baseUrl: string,
): PlatypusUIMessage[] {
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

      // Only the canonical form is rewritten: a part already carrying a served
      // URL came back from the client and is left as it is.
      const key = canonicalStorageKeyFromUrl(part.url);
      if (key === undefined) {
        return part;
      }

      return {
        ...part,
        url: servedUrlForKey(key, baseUrl),
      };
    });

    return {
      ...message,
      parts: processedParts,
    };
  });
}

/**
 * Resolve every stored File-part reference back to inline `data:` bytes so that
 * `convertToModelMessages()` can access file content without making HTTP
 * requests (which would fail without session cookies).
 *
 * This is an ephemeral transformation — only used in-memory for the
 * `streamText()` call. The DB continues to store canonical references.
 *
 * @param messages - Array of chat messages with parts
 * @param backendOrigin - The origin of the backend server, whose `/files/` URLs
 *   this deployment will resolve (e.g. http://localhost:4000)
 * @returns Modified messages with file URLs replaced by data: URLs
 */
export async function inlineFileUrls(
  messages: PlatypusUIMessage[],
  backendOrigin: string,
): Promise<PlatypusUIMessage[]> {
  const storage = getStorage();

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

          // Every form this deployment can have served, read back by the one
          // parser that knows them (issue #839). Anything else — inline
          // content, a URL naming another host — is left alone.
          const candidate = resolvableStorageKeyFromUrl(url, backendOrigin);
          if (!candidate) {
            return part;
          }

          // The client returned this URL to us, so the key is untrusted: a
          // traversal key here would otherwise read a host file and inline it
          // into the System prompt. `normalizeFileParts` announces the part as
          // unavailable, exactly as it does for a storage miss.
          if (!candidate.valid) {
            logger.warn(
              { key: candidate.key },
              "Rejected invalid storage key during inlining",
            );
            return part;
          }

          const key = candidate.key;

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
 * Delete everything stored under a deleted Chat's, Workspace's or
 * Organization's key prefix. Best-effort, and called only once the rows are
 * gone: a failure is logged and leaves an unreachable object behind, which is
 * harmless, where deleting first could leave rows pointing at missing files.
 */
export async function deleteStoredPrefix(prefix: string): Promise<void> {
  try {
    await getStorage().deletePrefix(prefix);
  } catch (error) {
    logger.error({ error, prefix }, "Failed to delete files from storage");
  }
}
