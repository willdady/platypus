"use client";

import type { ReactNode } from "react";
import type { ArtifactType } from "@platypus/schemas";
import { CopyIcon, DownloadIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { copyWithToast } from "@/lib/clipboard";
import { artifactTypeLabel } from "@/lib/artifact-file";
import { downloadArtifactContent } from "@/lib/artifact-download";
import { cn } from "@/lib/utils";
import { isArtifactDeleted, useArtifact } from "@/hooks/use-artifact";
import { ArtifactMarkdown, fencedCode } from "./artifact-markdown";
import { ListError, ListState } from "./list-state";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadingRegion } from "./list-skeletons";

/**
 * A `createArtifact` call's content before it is stored. The viewer shows it
 * while the call streams, and keeps showing it until the saved version has been
 * read, so opening or completing the call does not jump the panel from one
 * rendering to another. A failed call never presents its partial content as a
 * saved Artifact.
 */
export type ArtifactLive = {
  status: "streaming" | "failed";
  title?: string;
  type?: ArtifactType;
  language?: string | null;
  content: string;
  error?: string;
};

/** The language a Preview tab's fenced block is rendered as. */
function previewLanguage(
  type: ArtifactType | undefined,
  language?: string | null,
): string {
  if (type === undefined) return "text";
  switch (type) {
    case "markdown":
      return "markdown";
    case "code":
      return language || "text";
    case "mermaid":
      return "mermaid";
    case "html":
      return "html";
    case "svg":
      return "svg";
    default: {
      // A new ArtifactType must decide its own Preview language, not fall to text.
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}

/**
 * The language a Code tab's fenced block is highlighted as. A Mermaid block is
 * `text` here rather than `mermaid`, because the renderer draws a `mermaid`
 * fence as a diagram — the opposite of showing its source.
 */
function codeTabLanguage(
  type: ArtifactType | undefined,
  language?: string | null,
): string {
  return type === "mermaid" ? "text" : previewLanguage(type, language);
}

/**
 * The one Artifact viewer: the Chat's side panel and the full-page view. It
 * owns the Preview and Code tabs, copy and download for every type, while the
 * frame and the version picker are later additions. HTML and SVG are
 * source-only here — their frame is a separate slice — so Preview is offered
 * disabled rather than faking one. While a `createArtifact` call streams it
 * takes the partial content as `live`; a stored version always wins once read.
 */
export function ArtifactViewer({
  orgId,
  workspaceId,
  artifactId,
  version,
  live,
  onClose,
  className,
}: {
  orgId: string;
  workspaceId: string;
  /** The stored Artifact; absent while a call's content is not yet stored. */
  artifactId?: string;
  /** A named version; omitted reads the latest. */
  version?: number;
  live?: ArtifactLive;
  onClose?: () => void;
  className?: string;
}) {
  const { data, error, isLoading, mutate } = useArtifact(
    { orgId, workspaceId },
    artifactId,
    version,
  );

  if (error && isArtifactDeleted(error)) {
    return (
      <ArtifactFrame className={className} onClose={onClose} title="Artifact">
        <div className="p-4">
          <ListState variant="empty">This Artifact has been deleted.</ListState>
        </div>
      </ArtifactFrame>
    );
  }

  if (data) {
    const { artifact, version: current } = data;
    const previewAvailable =
      artifact.type !== "html" && artifact.type !== "svg";

    return (
      <ArtifactFrame
        className={className}
        onClose={onClose}
        title={artifact.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">
              {artifactTypeLabel(artifact.type)}
            </Badge>
            <span className="text-muted-foreground text-xs">
              Version {current.version}
            </span>
          </span>
        }
        actions={
          <>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Copy Artifact source"
              onClick={() => void copyWithToast(current.content, "Copied")}
            >
              <CopyIcon />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Download Artifact"
              onClick={() => downloadArtifactContent(artifact, current.content)}
            >
              <DownloadIcon />
            </Button>
          </>
        }
      >
        <ArtifactTabs
          type={artifact.type}
          language={artifact.language}
          content={current.content}
          previewAvailable={previewAvailable}
        />
      </ArtifactFrame>
    );
  }

  if (error) {
    return (
      <ArtifactFrame className={className} onClose={onClose} title="Artifact">
        <div className="p-4">
          <ListError
            error={error}
            subject="this artifact"
            onRetry={() => void mutate()}
          />
        </div>
      </ArtifactFrame>
    );
  }

  if (live?.status === "failed") {
    const title = live.title?.trim() || "Artifact";
    return (
      <ArtifactFrame
        className={className}
        onClose={onClose}
        title={title}
        subtitle={
          live.type ? (
            <Badge variant="secondary">{artifactTypeLabel(live.type)}</Badge>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-2 p-4">
          <ListState variant="empty">This Artifact was not saved.</ListState>
          {live.error && (
            <p className="text-destructive text-xs">{live.error}</p>
          )}
        </div>
      </ArtifactFrame>
    );
  }

  if (live) {
    const title = live.title?.trim() || "Creating Artifact…";
    const previewAvailable =
      live.type !== undefined && live.type !== "html" && live.type !== "svg";

    return (
      <ArtifactFrame
        className={className}
        onClose={onClose}
        title={title}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            {live.type && (
              <Badge variant="secondary">{artifactTypeLabel(live.type)}</Badge>
            )}
            <span className="text-muted-foreground text-xs">Streaming</span>
          </span>
        }
      >
        {live.content === "" ? (
          <div className="p-4">
            <ListState variant="empty">
              Waiting for the Agent to write this Artifact…
            </ListState>
          </div>
        ) : (
          <ArtifactTabs
            type={live.type}
            language={live.language}
            content={live.content}
            previewAvailable={previewAvailable}
          />
        )}
      </ArtifactFrame>
    );
  }

  if (isLoading) {
    return (
      <ArtifactFrame className={className} onClose={onClose} title="Artifact">
        <LoadingRegion
          label="Loading artifact"
          className="flex flex-col gap-3 p-4"
        >
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-40 w-full" />
        </LoadingRegion>
      </ArtifactFrame>
    );
  }

  return (
    <ArtifactFrame className={className} onClose={onClose} title="Artifact">
      <div className="p-4">
        <ListError
          error={error}
          subject="this artifact"
          onRetry={() => void mutate()}
        />
      </div>
    </ArtifactFrame>
  );
}

/**
 * The Preview and Code tabs for one piece of content. Preview is available for
 * every type except HTML and SVG, so a streaming call whose type is still
 * unknown opens on source rather than guessing.
 */
function ArtifactTabs({
  type,
  language,
  content,
  previewAvailable,
}: {
  type: ArtifactType | undefined;
  language?: string | null;
  content: string;
  previewAvailable: boolean;
}) {
  return (
    <Tabs
      defaultValue={previewAvailable ? "preview" : "code"}
      className="flex min-h-0 flex-1 flex-col gap-0"
    >
      <TabsList className="mx-4 mt-3 h-auto self-start p-0.5">
        <TabsTrigger
          value="preview"
          disabled={!previewAvailable}
          title={
            previewAvailable
              ? undefined
              : "Preview is unavailable for HTML and SVG Artifacts"
          }
          className="px-2 py-0.5 text-xs"
        >
          Preview
        </TabsTrigger>
        <TabsTrigger value="code" className="px-2 py-0.5 text-xs">
          Code
        </TabsTrigger>
      </TabsList>
      <TabsContent
        value="preview"
        className="mt-0 min-h-0 flex-1 overflow-auto p-4"
      >
        {type === "markdown" ? (
          <ArtifactMarkdown content={content} />
        ) : (
          <ArtifactMarkdown
            content={fencedCode(content, previewLanguage(type, language))}
          />
        )}
      </TabsContent>
      <TabsContent
        value="code"
        className="mt-0 min-h-0 flex-1 overflow-auto p-4"
      >
        <ArtifactMarkdown
          content={fencedCode(content, codeTabLanguage(type, language))}
        />
      </TabsContent>
    </Tabs>
  );
}

function ArtifactFrame({
  title,
  subtitle,
  actions,
  onClose,
  className,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  onClose?: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={`Artifact: ${title}`}
      className={cn("flex min-h-0 flex-col bg-background", className)}
    >
      <header className="flex items-start gap-2 border-b p-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="truncate font-semibold text-sm" title={title}>
            {title}
          </h2>
          {subtitle}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {actions}
          {onClose && (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Close Artifact"
              onClick={onClose}
            >
              <XIcon />
            </Button>
          )}
        </div>
      </header>
      {children}
    </section>
  );
}
