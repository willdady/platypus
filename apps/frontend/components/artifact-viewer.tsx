"use client";

import type { ReactNode } from "react";
import type { ArtifactType } from "@platypus/schemas";
import { CopyIcon, DownloadIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { copyWithToast } from "@/lib/clipboard";
import {
  artifactFileName,
  artifactFileExtension,
  artifactTypeLabel,
} from "@/lib/artifact-file";
import { cn } from "@/lib/utils";
import { isArtifactDeleted, useArtifact } from "@/hooks/use-artifact";
import { ArtifactMarkdown, fencedCode } from "./artifact-markdown";
import { ListError, ListState } from "./list-state";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadingRegion } from "./list-skeletons";

const TYPE_MEDIA: Record<ArtifactType, string> = {
  markdown: "text/markdown",
  code: "text/plain",
  mermaid: "text/plain",
  html: "text/html",
  svg: "image/svg+xml",
};

/** The language a Preview tab's fenced block is rendered as. */
function previewLanguage(type: ArtifactType, language?: string | null): string {
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
  }
}

/**
 * The language a Code tab's fenced block is highlighted as. A Mermaid block is
 * `text` here rather than `mermaid`, because the renderer draws a `mermaid`
 * fence as a diagram — the opposite of showing its source.
 */
function codeTabLanguage(type: ArtifactType, language?: string | null): string {
  return type === "mermaid" ? "text" : previewLanguage(type, language);
}

/**
 * The one Artifact viewer: the Chat's side panel and, in later slices, the
 * full-page view. It owns the Preview and Code tabs, copy and download for
 * every type, while the frame and the version picker are later additions.
 * HTML and SVG are source-only here — their frame is a separate slice — so
 * Preview is offered disabled rather than faking one.
 */
export function ArtifactViewer({
  orgId,
  workspaceId,
  artifactId,
  version,
  onClose,
  className,
}: {
  orgId: string;
  workspaceId: string;
  artifactId: string;
  /** A named version; omitted reads the latest. */
  version?: number;
  onClose?: () => void;
  className?: string;
}) {
  const { data, error, isLoading, mutate } = useArtifact(
    { orgId, workspaceId },
    artifactId,
    version,
  );

  if (isLoading && !data) {
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

  if (error && isArtifactDeleted(error)) {
    return (
      <ArtifactFrame className={className} onClose={onClose} title="Artifact">
        <div className="p-4">
          <ListState variant="empty">This Artifact has been deleted.</ListState>
        </div>
      </ArtifactFrame>
    );
  }

  if (error || !data) {
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

  const { artifact, version: current } = data;
  const previewAvailable = artifact.type !== "html" && artifact.type !== "svg";
  const initialTab = previewAvailable ? "preview" : "code";

  return (
    <ArtifactFrame
      className={className}
      onClose={onClose}
      title={artifact.title}
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{artifactTypeLabel(artifact.type)}</Badge>
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
            onClick={() =>
              downloadArtifact(
                artifact.title,
                artifact.type,
                artifact.language,
                current,
              )
            }
          >
            <DownloadIcon />
          </Button>
        </>
      }
    >
      <Tabs
        defaultValue={initialTab}
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
          {artifact.type === "markdown" ? (
            <ArtifactMarkdown content={current.content} />
          ) : (
            <ArtifactMarkdown
              content={fencedCode(
                current.content,
                previewLanguage(artifact.type, artifact.language),
              )}
            />
          )}
        </TabsContent>
        <TabsContent
          value="code"
          className="mt-0 min-h-0 flex-1 overflow-auto p-4"
        >
          <ArtifactMarkdown
            content={fencedCode(
              current.content,
              codeTabLanguage(artifact.type, artifact.language),
            )}
          />
        </TabsContent>
      </Tabs>
    </ArtifactFrame>
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

function downloadArtifact(
  title: string,
  type: ArtifactType,
  language: string | null | undefined,
  version: { content: string },
): void {
  const blob = new Blob([version.content], { type: TYPE_MEDIA[type] });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = artifactFileName(title, type, language);
    link.rel = "noreferrer";
    document.body.appendChild(link);
    link.click();
    link.remove();
  } catch {
    toast.error(
      `Could not download this .${artifactFileExtension(type, language)} file`,
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}
