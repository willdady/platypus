"use client";

import type { ReactNode } from "react";
import {
  ArrowUpRightIcon,
  DownloadIcon,
  FileArchiveIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileVideoIcon,
  GlobeIcon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react";
import { useParams } from "next/navigation";
import {
  formatFileSize,
  type ArtifactType,
  type PlatypusUIMessage,
} from "@platypus/schemas";
import { useBackendUrl } from "@/components/auth-provider";
import { Button } from "@/components/ui/button";
import { scopedUrl, type Scope } from "@/lib/api-write";
import { artifactTypeLabel } from "@/lib/artifact-file";
import { downloadArtifactContent } from "@/lib/artifact-download";
import { useStoredArtifact } from "@/hooks/use-artifact";
import {
  ARTIFACT_DELETED_DETAIL,
  type ArtifactOpenTarget,
  type StoredArtifact,
} from "./artifact-tool-card";

type MessagePart = NonNullable<PlatypusUIMessage["parts"]>[number];

export type OfferedFile = { path: string; size?: number };

export function offeredFiles(parts: readonly MessagePart[]): OfferedFile[] {
  const byPath = new Map<string, OfferedFile>();
  for (const part of parts) {
    if (part.type === "tool-fsDownload" && part.state === "output-available") {
      byPath.set(part.output.path, part.output);
    }
  }
  return [...byPath.values()];
}

// why: the download route says octet-stream for everything, so icons go by extension
const ICONS: Array<[LucideIcon, string[]]> = [
  [FileImageIcon, ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"]],
  [FileSpreadsheetIcon, ["csv", "tsv", "xls", "xlsx", "ods"]],
  [FileTextIcon, ["txt", "md", "pdf", "doc", "docx", "rtf", "odt", "log"]],
  [FileArchiveIcon, ["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar"]],
  [FileAudioIcon, ["mp3", "wav", "ogg", "flac", "m4a"]],
  [FileVideoIcon, ["mp4", "mov", "webm", "mkv", "avi"]],
  [
    FileCodeIcon,
    [
      "json",
      "js",
      "ts",
      "tsx",
      "jsx",
      "py",
      "html",
      "css",
      "xml",
      "yaml",
      "yml",
      "sh",
      "sql",
    ],
  ],
];

function fileIcon(name: string): LucideIcon {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return ICONS.find(([, exts]) => exts.includes(ext))?.[0] ?? FileIcon;
}

const ARTIFACT_ICONS: Record<ArtifactType, LucideIcon> = {
  markdown: FileTextIcon,
  code: FileCodeIcon,
  mermaid: WorkflowIcon,
  html: GlobeIcon,
  svg: FileImageIcon,
};

function TrayRow({
  icon: Icon,
  name,
  detail,
  fullName,
  children,
}: {
  icon: LucideIcon;
  name: string;
  detail: ReactNode;
  fullName: string;
  children?: ReactNode;
}) {
  return (
    <li className="flex items-center gap-3 rounded-lg border bg-card p-3">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted">
        <Icon className="size-5 text-muted-foreground" />
      </span>
      <div className="min-w-0 flex-1" title={fullName}>
        <div className="truncate font-medium text-sm">{name}</div>
        <div className="flex gap-2 text-muted-foreground text-xs">{detail}</div>
      </div>
      <div className="flex shrink-0 gap-2">{children}</div>
    </li>
  );
}

function ArtifactRow({
  artifact,
  scope,
  onOpen,
}: {
  artifact: StoredArtifact;
  scope?: Scope | null;
  onOpen?: (target: ArtifactOpenTarget) => void;
}) {
  const { data, deleted } = useStoredArtifact(artifact, scope);
  const type = data?.artifact.type;
  const title = data?.artifact.title ?? artifact.title;

  return (
    <TrayRow
      icon={type ? ARTIFACT_ICONS[type] : FileIcon}
      name={title}
      detail={
        <span className="min-w-0 truncate">
          {deleted
            ? ARTIFACT_DELETED_DETAIL
            : [
                type ? artifactTypeLabel(type) : undefined,
                `Version ${artifact.version}`,
              ]
                .filter(Boolean)
                .join(" · ")}
        </span>
      }
      fullName={title}
    >
      {!deleted && onOpen && (
        <Button
          size="sm"
          onClick={() => onOpen({ id: artifact.id, version: artifact.version })}
        >
          <ArrowUpRightIcon /> Open
        </Button>
      )}
      {data && !deleted && (
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            downloadArtifactContent(data.artifact, data.version.content)
          }
        >
          <DownloadIcon /> Download
        </Button>
      )}
    </TrayRow>
  );
}

export function OfferedFiles({
  files,
  artifacts,
  scope,
  onOpen,
}: {
  files: OfferedFile[];
  artifacts: StoredArtifact[];
  scope?: Scope | null;
  onOpen?: (target: ArtifactOpenTarget) => void;
}) {
  const backendUrl = useBackendUrl();
  const params = useParams<{ orgId: string; workspaceId: string }>();

  return (
    <ul aria-label="Files and artifacts" className="flex flex-col gap-2 pl-8">
      {files.map(({ path, size }) => {
        const name = path.split("/").pop() || path;
        return (
          <TrayRow
            key={path}
            icon={fileIcon(name)}
            name={name}
            fullName={path}
            detail={
              <>
                <span className="min-w-0 truncate font-mono">{path}</span>
                {size !== undefined && (
                  <span className="shrink-0">{formatFileSize(size)}</span>
                )}
              </>
            }
          >
            {backendUrl && (
              <Button size="sm" asChild>
                <a
                  href={`${scopedUrl(backendUrl, "sandbox/file", params)}?${new URLSearchParams({ path })}`}
                >
                  <DownloadIcon /> Download
                </a>
              </Button>
            )}
          </TrayRow>
        );
      })}
      {artifacts.map((artifact) => (
        <ArtifactRow
          key={artifact.id}
          artifact={artifact}
          scope={scope}
          onOpen={onOpen}
        />
      ))}
    </ul>
  );
}
