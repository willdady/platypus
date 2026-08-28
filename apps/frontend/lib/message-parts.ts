import type { FileUIPart, TextUIPart } from "ai";

/**
 * The loosest shape these readers need: a part is anything with a `type`, and
 * whatever else that type brings with it. Deliberately not `UIMessage["parts"]`
 * — the part union is generic over a Chat's tools and data parts, and these
 * readers only ever ask what kind of part they are looking at.
 */
type UnknownPart = { type: string; [key: string]: unknown };

/**
 * What a message carrying files and no words of its own is sent as. Shared by
 * the composer and the edit surface, so an attachment-only turn reads the same
 * whether it was sent or edited into being.
 */
export const ATTACHMENTS_ONLY_TEXT = "Sent with attachments";

/**
 * Whether a file part should render as an image rather than a generic file
 * attachment. An image media type with no URL (a Provider-reference-only
 * file, or a still-uploading part) has nothing a client can put in an `<img
 * src>` — falling back to the file card there is strictly better than a
 * broken image, so the URL is required alongside the media type (issue #579).
 */
export const isImageAttachment = (
  part: Pick<FileUIPart, "mediaType" | "url">,
): boolean => Boolean(part.mediaType?.startsWith("image/") && part.url);

/**
 * The message as one string: every text part, in order, joined. A turn can
 * carry several — a model that wrote, called a tool, and wrote again — and
 * they are one message to a reader, so Copy and the edit surface both open
 * from this rather than each keeping their own idea of it.
 */
export const messageText = (
  parts: readonly UnknownPart[] | undefined,
): string =>
  (parts ?? [])
    .filter((part): part is TextUIPart => part.type === "text")
    .map((part) => part.text)
    .join("");

/**
 * Every file the message carries, in the order it carries them. Images are
 * included: they render inline in the transcript but are attachments in an
 * edit surface, and an edit that kept only the non-image ones would drop the
 * screenshot the question was about (issue #710).
 */
export const messageAttachments = (
  parts: readonly UnknownPart[] | undefined,
): FileUIPart[] =>
  (parts ?? []).filter((part): part is FileUIPart => part.type === "file");
