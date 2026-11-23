import {
  classifyFile,
  isTextLikeExtension,
  mediaTypeMatches,
  type FileClassification,
} from "@platypus/schemas";

export { isTextLikeExtension, mediaTypeMatches };

export type FilePartClass = FileClassification;

const SNIFF_BYTES = 8_000;

export const looksBinary = (bytes: Uint8Array): boolean => {
  const end = Math.min(bytes.length, SNIFF_BYTES);
  for (let i = 0; i < end; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
};

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
