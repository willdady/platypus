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

/**
 * Elements that make the browser request a URL by themselves. The default
 * schema allows `picture`/`source` and their `srcSet`, which no `img` renderer
 * sees — a remote image there would load without passing the image rule below.
 */
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

/**
 * Streamdown's own chain blocks a `data:` image before any renderer sees it.
 * This is the same sanitisation without that one rule: the image component
 * below is the decision point, and every other tag and attribute still goes
 * through the default schema. Connectors that bypass that renderer — `source`
 * and `picture`, a media element, a frame — are dropped whole. Links keep
 * their protocol rules.
 */
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

/** The props Streamdown hands an `img` renderer. */
type ArtifactImageProps = ClassAttributes<HTMLImageElement> &
  ImgHTMLAttributes<HTMLImageElement> &
  ExtraProps;

/**
 * An image inside a markdown Artifact. Only `data:` URIs and this deployment's
 * own stored files are given a `src`, so any other host is never contacted.
 * A blocked image keeps its URL visible as a link, because a silently missing
 * picture is worse than one the reader can open deliberately.
 */
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

/**
 * Markdown rendered the way a Chat message is, with the Artifact's own image
 * rule applied. Markdown, code and Mermaid Artifacts all reach the same
 * renderer; a code Artifact is wrapped in a fenced block so it highlights.
 * `storageBaseUrl` is the base the Artifact read named for this deployment's
 * stored files (a bucket or CDN when one is configured), so an image served
 * from there loads; while a call is still streaming there is no read to carry
 * it, and such an image stays blocked until the stored version is read.
 */
export function ArtifactMarkdown({
  content,
  storageBaseUrl,
  className,
}: {
  content: string;
  storageBaseUrl?: string | null;
  className?: string;
}) {
  const components = useMemo(
    () => ({
      img: (props: ArtifactImageProps) => (
        <ArtifactImage {...props} storageBaseUrl={storageBaseUrl} />
      ),
    }),
    [storageBaseUrl],
  );

  return (
    <MessageResponse
      className={className}
      components={components}
      rehypePlugins={artifactRehypePlugins}
      // The sanitised source is handed over unchanged: the renderer above is
      // what decides which ones become a request, and a blocked one renders
      // as a placeholder rather than disappearing.
      urlTransform={(url) => url}
    >
      {content}
    </MessageResponse>
  );
}

/** A fenced code block whose fence outruns any backticks in the content. */
export function fencedCode(content: string, language: string): string {
  const longestRun = Math.max(
    2,
    ...(content.match(/`+/g) ?? []).map((run) => run.length),
  );
  const fence = "`".repeat(longestRun + 1);
  return `${fence}${language}\n${content}\n${fence}`;
}
