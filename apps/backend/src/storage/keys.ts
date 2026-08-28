import { ValidationError } from "../errors.ts";

/**
 * A storage key names one stored object relative to the backend's root. Two
 * shapes are generated, and nothing else is: a File part's
 * `{orgId}/{workspaceId}/{chatId}/{messageId}/{partIndex}-{hash8}.{ext}`
 * (`generateStorageKey`), and an Agent avatar's
 * `agents/{agentId}/avatar-{nanoid}.webp` (`storeAvatar`).
 *
 * Keys are not held only by Platypus. A File part's key round-trips through the
 * client: the read path rewrites `storage://<key>` to an HTTP URL, the Chat
 * resubmits its full history every turn, and `inlineFileUrls` reads the key back
 * out of the URL the client returned. So a key arriving from a message part is
 * untrusted input, and is validated here — at the boundary where it enters —
 * rather than inside one backend, which would leave `S3Storage` uncovered.
 */

/**
 * Every character a generated key can contain. Both generated shapes use only
 * ids, hex hashes, `nanoid`'s alphabet (which adds `-` and `_`), and a file
 * extension, so this admits every real key while excluding the separators a
 * traversal needs: `/` is handled per segment, and `\`, `%` and NUL cannot
 * appear at all. Rejecting `%` also refuses a percent-encoded separator
 * (`..%2f`), which the `/files/*` route would otherwise pass through verbatim —
 * `c.req.path` is not decoded.
 */
const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Generated keys are far shorter than this; the cap bounds a hostile one. */
const MAX_KEY_LENGTH = 1024;

/**
 * Whether a key is one Platypus could have stored — a relative POSIX path whose
 * every segment is safe. Rejects absolute keys, empty or `.`/`..` segments, and
 * any character outside {@link SEGMENT_PATTERN}.
 */
export function isValidStorageKey(key: string): boolean {
  if (!key || key.length > MAX_KEY_LENGTH) {
    return false;
  }

  return key
    .split("/")
    .every(
      (segment) =>
        segment !== "." && segment !== ".." && SEGMENT_PATTERN.test(segment),
    );
}

/**
 * Assert a key is safe before it reaches a storage backend. Throws
 * `ValidationError` so the `onError` seam answers 400 (ADR-0010) — a malformed
 * key is a bad request, not a server fault.
 */
export function assertValidStorageKey(key: string): void {
  if (!isValidStorageKey(key)) {
    throw new ValidationError("Invalid file key");
  }
}
