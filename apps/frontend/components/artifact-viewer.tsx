"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import type { ArtifactType } from "@platypus/schemas";
import {
  CopyIcon,
  DownloadIcon,
  Maximize2Icon,
  Minimize2Icon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { copyWithToast } from "@/lib/clipboard";
import { formatDateTime } from "@/lib/format-date";
import { artifactTypeLabel } from "@/lib/artifact-file";
import { downloadArtifactContent } from "@/lib/artifact-download";
import { cn } from "@/lib/utils";
import {
  isArtifactDeleted,
  useArtifact,
  useArtifactVersions,
} from "@/hooks/use-artifact";
import { ArtifactMarkdown, fencedCode } from "./artifact-markdown";
import { ArtifactPreviewFrame } from "./artifact-preview-frame";
import { isFramedArtifactType } from "@/lib/artifact-frame";
import { ListError, ListState } from "./list-state";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadingRegion } from "./list-skeletons";

export type ArtifactLive = {
  status: "streaming" | "failed";
  title?: string;
  type?: ArtifactType;
  language?: string | null;
  content: string;
  error?: string;
};

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
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}

function codeTabLanguage(
  type: ArtifactType | undefined,
  language?: string | null,
): string {
  return type === "mermaid" ? "text" : previewLanguage(type, language);
}

export function ArtifactViewer({
  orgId,
  workspaceId,
  artifactId,
  version,
  live,
  onClose,
  fullScreen,
  className,
}: {
  orgId: string;
  workspaceId: string;
  artifactId?: string;
  version?: number;
  live?: ArtifactLive;
  onClose?: () => void;
  fullScreen?: ArtifactFullScreen;
  className?: string;
}) {
  const scope = { orgId, workspaceId };
  // why: a picked version is remembered only for the version it was picked against
  const versionKey = `${artifactId}:${version ?? "latest"}`;
  const [picked, setPicked] = useState<{
    key: string;
    version: number;
  } | null>(null);
  const selected = picked?.key === versionKey ? picked.version : version;

  const { data, error, isLoading, mutate } = useArtifact(
    scope,
    artifactId,
    selected,
  );
  const { data: versions } = useArtifactVersions(scope, artifactId);

  if (error && isArtifactDeleted(error)) {
    return (
      <ArtifactFrame
        fullScreen={fullScreen}
        className={className}
        onClose={onClose}
        title="Artifact"
      >
        <div className="p-4">
          <ListState variant="empty">This Artifact has been deleted.</ListState>
        </div>
      </ArtifactFrame>
    );
  }

  if (data) {
    const { artifact, version: current } = data;
    const latestVersion = versions?.results[0]?.version;
    const isLatest =
      latestVersion === undefined || latestVersion === current.version;
    return (
      <ArtifactFrame
        fullScreen={fullScreen}
        className={className}
        onClose={onClose}
        title={artifact.title}
        tabs={{ type: artifact.type, streaming: false }}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">
              {artifactTypeLabel(artifact.type)}
            </Badge>
            {versions && versions.results.length > 0 ? (
              <Select
                value={String(selected ?? current.version)}
                onValueChange={(value) =>
                  setPicked({ key: versionKey, version: Number(value) })
                }
              >
                <SelectTrigger
                  size="sm"
                  aria-label="Artifact version"
                  className="gap-1 px-2 text-xs data-[size=sm]:h-6"
                >
                  <SelectValue>{`Version ${selected ?? current.version}`}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {versions.results.map((entry) => (
                    <SelectItem
                      key={entry.version}
                      value={String(entry.version)}
                      className="text-xs"
                    >
                      {`Version ${entry.version} · ${
                        entry.author === "agent" ? "Agent" : "You"
                      } · ${formatDateTime(entry.createdAt)}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="text-muted-foreground text-xs">
                Version {current.version}
              </span>
            )}
            {!isLatest && <Badge variant="outline">Read-only</Badge>}
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
          scriptOrigins={data.scriptOrigins}
          storageBaseUrl={data.storageBaseUrl}
        />
      </ArtifactFrame>
    );
  }

  if (error) {
    return (
      <ArtifactFrame
        fullScreen={fullScreen}
        className={className}
        onClose={onClose}
        title="Artifact"
      >
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
        fullScreen={fullScreen}
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

    return (
      <ArtifactFrame
        fullScreen={fullScreen}
        className={className}
        onClose={onClose}
        title={title}
        tabs={
          live.content === "" ? undefined : { type: live.type, streaming: true }
        }
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
            streaming
          />
        )}
      </ArtifactFrame>
    );
  }

  if (isLoading) {
    return (
      <ArtifactFrame
        fullScreen={fullScreen}
        className={className}
        onClose={onClose}
        title="Artifact"
      >
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
    <ArtifactFrame
      fullScreen={fullScreen}
      className={className}
      onClose={onClose}
      title="Artifact"
    >
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

const MERMAID_FILL = cn(
  "flex flex-col",
  "[&_[data-streamdown=mermaid-block]]:my-0 [&_[data-streamdown=mermaid-block]]:min-h-0 [&_[data-streamdown=mermaid-block]]:flex-1",
  "[&_[data-streamdown=mermaid-block]>div:last-child]:min-h-0 [&_[data-streamdown=mermaid-block]>div:last-child]:flex-1",
  "[&_[data-streamdown=mermaid]]:h-full [&_[data-streamdown=mermaid]]:max-h-none",
  "[&_[data-streamdown=mermaid]>div]:!h-full [&_[data-streamdown=mermaid]>div]:!max-h-none",
);

const CODE_FILL = cn(
  "flex flex-col",
  "[&_[data-streamdown=code-block]]:my-0 [&_[data-streamdown=code-block]]:min-h-0 [&_[data-streamdown=code-block]]:flex-1",
  "[&_[data-streamdown=code-block-body]]:min-h-0 [&_[data-streamdown=code-block-body]]:flex-1 [&_[data-streamdown=code-block-body]]:!max-h-none",
);

function isPreviewAvailable(
  type: ArtifactType | undefined,
  streaming: boolean,
): boolean {
  return type !== undefined && !(streaming && isFramedArtifactType(type));
}

function ArtifactTabs({
  type,
  language,
  content,
  scriptOrigins = [],
  storageBaseUrl,
  streaming = false,
}: {
  type: ArtifactType | undefined;
  language?: string | null;
  content: string;
  scriptOrigins?: readonly string[];
  storageBaseUrl?: string | null;
  streaming?: boolean;
}) {
  const framed = !streaming && type !== undefined && isFramedArtifactType(type);
  return (
    <>
      <TabsContent
        value="preview"
        className={
          framed
            ? "mt-0 min-h-0 flex-1 overflow-hidden p-4"
            : "mt-0 min-h-0 flex-1 overflow-auto p-4"
        }
      >
        {type !== undefined && isFramedArtifactType(type) ? (
          <ArtifactPreviewFrame
            type={type}
            content={content}
            scriptOrigins={scriptOrigins}
          />
        ) : type === "markdown" ? (
          <ArtifactMarkdown
            content={content}
            storageBaseUrl={storageBaseUrl}
            className="mx-auto max-w-3xl"
            gutter="document"
          />
        ) : type === "mermaid" ? (
          <ArtifactMarkdown
            content={fencedCode(content, previewLanguage(type, language))}
            className={MERMAID_FILL}
          />
        ) : (
          <ArtifactMarkdown
            content={fencedCode(content, previewLanguage(type, language))}
            className={CODE_FILL}
            gutter="source"
          />
        )}
      </TabsContent>
      <TabsContent
        value="code"
        className="mt-0 min-h-0 flex-1 overflow-auto p-4"
      >
        <ArtifactMarkdown
          content={fencedCode(content, codeTabLanguage(type, language))}
          className={CODE_FILL}
          gutter="source"
        />
      </TabsContent>
    </>
  );
}

export type ArtifactFullScreen = {
  readonly active: boolean;
  readonly onToggle: () => void;
};

function ArtifactFrame({
  title,
  subtitle,
  actions,
  onClose,
  fullScreen,
  tabs,
  className,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  tabs?: { type: ArtifactType | undefined; streaming: boolean };
  actions?: ReactNode;
  onClose?: () => void;
  fullScreen?: ArtifactFullScreen;
  className?: string;
  children: ReactNode;
}) {
  const previewAvailable =
    tabs !== undefined && isPreviewAvailable(tabs.type, tabs.streaming);
  const body = (
    <>
      <header className="flex flex-col gap-3 border-b p-4">
        <div className="flex items-center gap-2">
          <h2
            className="min-w-0 flex-1 truncate font-semibold text-sm"
            title={title}
          >
            {title}
          </h2>
          <div className="-my-1.5 flex shrink-0 items-center gap-1">
            {actions}
            {fullScreen && (
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="hidden lg:inline-flex"
                aria-label={
                  fullScreen.active ? "Exit full screen" : "View full screen"
                }
                onClick={fullScreen.onToggle}
              >
                {fullScreen.active ? <Minimize2Icon /> : <Maximize2Icon />}
              </Button>
            )}
            {onClose && (
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                // why: below lg Exit full screen is hidden, so Close stays there
                className={fullScreen?.active ? "lg:hidden" : undefined}
                aria-label="Close Artifact"
                onClick={onClose}
              >
                <XIcon />
              </Button>
            )}
          </div>
        </div>
        {(subtitle || tabs) && (
          <div className="flex flex-wrap items-center gap-2">
            {subtitle}
            {tabs && (
              <TabsList className="ml-auto h-auto p-0.5">
                <TabsTrigger
                  value="preview"
                  disabled={!previewAvailable}
                  title={
                    previewAvailable
                      ? undefined
                      : tabs.streaming
                        ? "Preview is unavailable until the Agent finishes writing this Artifact"
                        : "Preview is unavailable until the Artifact's type is known"
                  }
                  className="px-2 py-0.5 text-xs"
                >
                  Preview
                </TabsTrigger>
                <TabsTrigger value="code" className="px-2 py-0.5 text-xs">
                  Code
                </TabsTrigger>
              </TabsList>
            )}
          </div>
        )}
      </header>
      {children}
    </>
  );

  return (
    <section
      aria-label={`Artifact: ${title}`}
      className={cn("flex min-h-0 flex-col bg-background", className)}
    >
      {tabs ? (
        <Tabs
          defaultValue={previewAvailable ? "preview" : "code"}
          className="flex min-h-0 flex-1 flex-col gap-0"
        >
          {body}
        </Tabs>
      ) : (
        body
      )}
    </section>
  );
}
