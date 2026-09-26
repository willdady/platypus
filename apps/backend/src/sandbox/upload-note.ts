import type { DataUIPart, TextPart, UIDataTypes } from "ai";
import { formatFileSize, sandboxUploadSchema } from "@platypus/schemas";

/**
 * What the model is told about a User's Sandbox upload: a note of where the
 * file landed and how big it was. The part is never resolved to bytes — the
 * Agent reads the file with its Sandbox tools, and finds out then if it has
 * changed since.
 */
export const convertDataPart = (
  part: DataUIPart<UIDataTypes>,
): TextPart | undefined => {
  if (part.type !== "data-sandbox-upload") return undefined;
  // Validated on the way in (`resolveTurn`), so a failure here is a stored row
  // gone wrong, and says so.
  const { filename, path, size } = sandboxUploadSchema.parse(part.data);
  return {
    type: "text",
    text: `User uploaded \`${filename}\` (${formatFileSize(size)}) to the Sandbox at \`${path}\``,
  };
};
