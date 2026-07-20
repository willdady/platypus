/**
 * Pure classification of a file message part against a model's declared
 * `passthroughFileTypes` (issue #328). The gate and the send-time normalizer
 * share this logic so the reject decision and the transform decision never
 * drift.
 *
 * Three outcomes:
 * - `passthrough` — the model ingests this media type natively; send unchanged.
 * - `text`        — not native, but the file is textual; inline it as text.
 * - `reject`      — not native and not textual (a binary document); the turn is
 *                   rejected (Phase 1) or extracted to text (Phase 2).
 *
 * Text-vs-binary is decided from the file's *real nature* — its extension plus,
 * when bytes are available, a NUL-byte content sniff — never from the
 * browser-supplied media type, which is an unreliable, OS-specific lottery
 * (`.py` → `text/x-python` but `.md` → `application/octet-stream`).
 */
import {
  classifyFile,
  isTextLikeExtension,
  mediaTypeMatches,
  type FileClassification,
} from "@platypus/schemas";

// The media-type matcher and the text-extension test live in @platypus/schemas
// so the backend gate and the frontend warning share one copy. Re-exported so
// this module remains the single classification import surface (incl. tests).
export { isTextLikeExtension, mediaTypeMatches };

export type FilePartClass = FileClassification;

/** How many leading bytes to sniff for the NUL-byte binary heuristic. */
const SNIFF_BYTES = 8_000;

/** Whether content looks binary — a NUL byte in the sniffed prefix. */
export const looksBinary = (bytes: Uint8Array): boolean => {
  const end = Math.min(bytes.length, SNIFF_BYTES);
  for (let i = 0; i < end; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
};

/**
 * Classify a file part. `bytes` (the decoded file content) is optional: the
 * pre-persist gate classifies on metadata alone, while the send-time normalizer
 * passes bytes so a text-extension file that is actually binary is caught.
 */
export const classifyFilePart = (
  part: { mediaType?: string; filename?: string },
  passthroughFileTypes: string[],
  bytes?: Uint8Array,
): FilePartClass => {
  return classifyFile(
    part,
    passthroughFileTypes,
    bytes ? looksBinary(bytes) : false,
  );
};
