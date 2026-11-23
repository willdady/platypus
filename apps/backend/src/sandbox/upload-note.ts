import type { DataUIPart, TextPart, UIDataTypes } from "ai";
import { formatFileSize, sandboxUploadSchema } from "@platypus/schemas";

export const convertDataPart = (
  part: DataUIPart<UIDataTypes>,
): TextPart | undefined => {
  if (part.type !== "data-sandbox-upload") return undefined;
  const { path, size } = sandboxUploadSchema.parse(part.data);
  return {
    type: "text",
    text: `User uploaded \`${path}\` (${formatFileSize(size)}) to the Sandbox`,
  };
};
