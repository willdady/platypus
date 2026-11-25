import type { FileUIPart, TextUIPart } from "ai";
import type { SandboxUpload } from "@platypus/schemas";

// why: not UIMessage["parts"] — that union is generic over a Chat's tools and data parts
type UnknownPart = { type: string; [key: string]: unknown };

export const ATTACHMENTS_ONLY_TEXT = "Sent with attachments";

export function isImageAttachment(
  part: Pick<FileUIPart, "mediaType" | "url">,
): boolean {
  return Boolean(part.mediaType?.startsWith("image/") && part.url);
}

export function messageText(parts: readonly UnknownPart[] | undefined): string {
  return (parts ?? [])
    .filter((part): part is TextUIPart => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function messageAttachments(
  parts: readonly UnknownPart[] | undefined,
): FileUIPart[] {
  return (parts ?? []).filter(
    (part): part is FileUIPart => part.type === "file",
  );
}

export function messageSandboxUploads(
  parts: readonly UnknownPart[] | undefined,
): SandboxUpload[] {
  return (parts ?? [])
    .filter((part) => part.type === "data-sandbox-upload")
    .map((part) => part.data as SandboxUpload);
}

export function toolErrorText(part: {
  state: string;
  errorText?: string;
  approval?: { reason?: string };
}): string | undefined {
  return (
    part.errorText ??
    (part.state === "output-denied" ? part.approval?.reason : undefined)
  );
}
