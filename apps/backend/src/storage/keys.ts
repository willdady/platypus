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

/** The Chat a File part's key belongs to — the key's first three segments. */
export interface ChatKeyScope {
  orgId: string;
  workspaceId: string;
  chatId: string;
}

/**
 * The prefix every File part key for one Chat shares. `generateStorageKey`
 * builds keys from this and {@link isKeyUnderChat} reads them back with it, so
 * the writer and the ownership check cannot drift apart.
 */
export function chatStorageKeyPrefix(scope: ChatKeyScope): string {
  return `${scope.orgId}/${scope.workspaceId}/${scope.chatId}/`;
}

/**
 * Whether a key names an object stored for this Chat.
 *
 * Validity is not ownership. `isValidStorageKey` answers "could Platypus have
 * stored this?", which every well-formed key satisfies — including one naming
 * another tenant's file. A client can put any URL on a file part (`extractFiles`
 * stores a non-`data:` URL verbatim), so a key read back out of a message part
 * says only what the client claimed, not what this Chat owns. Anything
 * destructive must ask this question instead.
 */
export function isKeyUnderChat(key: string, scope: ChatKeyScope): boolean {
  return isValidStorageKey(key) && key.startsWith(chatStorageKeyPrefix(scope));
}
