"use client";

import { isPresentableUrl } from "@platypus/schemas";
import { useMemo, type ClassAttributes, type ImgHTMLAttributes } from "react";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { ExtraProps } from "streamdown";
import { useBackendUrl } from "@/components/auth-provider";
import { resolveArtifactImageSource } from "@/lib/artifact-file";
import {
  MessageResponse,
  type MessageResponseProps,
} from "./ai-elements/message";

// why: picture/source srcSet loads without the image rule, so those tags are dropped whole
const REQUEST_TRIGGERING_ELEMENTS = new Set([
  "audio",
  "base",
  "embed",
  "form",
  "iframe",
  "link",
  "meta",
  "object",
  "picture",
  "script",
  "source",
  "track",
  "video",
]);

export const artifactSchema = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter(
    (tag) => !REQUEST_TRIGGERING_ELEMENTS.has(tag),
  ),
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src ?? []), "data"],
  },
};
const artifactRehypePlugins: NonNullable<
  MessageResponseProps["rehypePlugins"]
> = [rehypeRaw, [rehypeSanitize, artifactSchema]];

type ArtifactImageProps = ClassAttributes<HTMLImageElement> &
  ImgHTMLAttributes<HTMLImageElement> &
  ExtraProps;

function ArtifactImage({
  storageBaseUrl,
  ...props
}: ArtifactImageProps & { storageBaseUrl?: string | null }) {
  const backendUrl = useBackendUrl();
  const url = typeof props.src === "string" ? props.src : undefined;
  const alt = typeof props.alt === "string" ? props.alt : undefined;
  const resolved = url
    ? resolveArtifactImageSource(url, backendUrl, storageBaseUrl)
    : undefined;

  if (resolved !== undefined) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={resolved}
        alt={alt ?? ""}
        className="max-w-full rounded-lg border"
        loading="lazy"
        decoding="async"
      />
    );
  }

  return (
    <span
      data-blocked-image=""
      className="my-2 inline-flex max-w-full flex-col gap-1 rounded-lg border-2 border-dashed px-3 py-2 text-muted-foreground text-xs"
    >
      <span>Image blocked{alt ? `: ${alt}` : ""}</span>
      {url &&
        (isPresentableUrl(url) ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer noopener"
            className="truncate underline"
          >
            {url}
          </a>
        ) : (
          <span className="truncate">{url}</span>
        ))}
    </span>
  );
}

export type ArtifactGutter = "document" | "source";

// why: a document outgrows its pane-high box, hiding the pane's inset; source scrolls inside its block
const GUTTER: Record<ArtifactGutter, string> = {
  document: "pb-4",
  source: "size-full [&_[data-streamdown=code-block-body]]:pb-8",
};

export function ArtifactMarkdown({
  content,
  storageBaseUrl,
  className,
  gutter,
}: {
  content: string;
  storageBaseUrl?: string | null;
  className?: string;
  gutter?: ArtifactGutter;
}) {
  const components = useMemo(
    () => ({
      img: (props: ArtifactImageProps) => (
        <ArtifactImage {...props} storageBaseUrl={storageBaseUrl} />
      ),
    }),
    [storageBaseUrl],
  );

  const document = (
    <MessageResponse
      className={className}
      components={components}
      rehypePlugins={artifactRehypePlugins}
      urlTransform={(url) => url}
    >
      {content}
    </MessageResponse>
  );

  return gutter ? (
    <div data-testid="artifact-gutter" className={GUTTER[gutter]}>
      {document}
    </div>
  ) : (
    document
  );
}

export function fencedCode(content: string, language: string): string {
  const longestRun = Math.max(
    2,
    ...(content.match(/`+/g) ?? []).map((run) => run.length),
  );
  const fence = "`".repeat(longestRun + 1);
  return `${fence}${language}\n${content}\n${fence}`;
}
