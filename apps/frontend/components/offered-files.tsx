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

// `size` is missing when the Sandbox backend doesn't report one.
export type OfferedFile = { path: string; size?: number };

/**
 * Every file the model offered with `fsDownload` in one message, across all
 * its steps: one entry per path, carrying the latest offer's size. Failed and
 * unfinished calls offer nothing.
 */
export function offeredFiles(parts: readonly MessagePart[]): OfferedFile[] {
  const byPath = new Map<string, OfferedFile>();
  for (const part of parts) {
    if (part.type === "tool-fsDownload" && part.state === "output-available") {
      byPath.set(part.output.path, part.output);
    }
  }
  return [...byPath.values()];
}

// The download route answers `application/octet-stream` for everything, so the
// extension is all there is to go on.
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

/** An Artifact row's icon, by the Artifact's type rather than a file name. */
const ARTIFACT_ICONS: Record<ArtifactType, LucideIcon> = {
  markdown: FileTextIcon,
  code: FileCodeIcon,
  mermaid: WorkflowIcon,
  html: GlobeIcon,
  svg: FileImageIcon,
};

/**
 * One row of the tray, whichever kind it is: an icon in a slot, a name with a
 * detail line under it, and the row's own actions at the end. Both kinds share
 * it so a file and an Artifact read as the same tray.
 */
function TrayRow({
  icon: Icon,
  name,
  detail,
  fullName,
  children,
}: {
  icon: LucideIcon;
  /** The row's first line, truncated rather than wrapped. */
  name: string;
  /** The line under it: a path and size, or a type and version. */
  detail: ReactNode;
  /** The whole value `name` stands in for, shown on hover. */
  fullName: string;
  /** The row's actions, if it has any. */
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

/**
 * One stored Artifact the finished reply wrote, read back at that version. The
 * read is what tells the row its type, its content and whether the Artifact is
 * gone: a deleted one says so and offers neither **Open** nor **Download**.
 * **Open** needs only the id and version, so it is offered as soon as the row
 * is; **Download** waits for the content.
 */
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

/**
 * The things a finished reply produced for the reader, as one tray under it:
 * the Sandbox files it offered for download (ADR-0027) and the Artifacts it
 * created or changed, each at the version that reply wrote. The tool results
 * hold only a path or an id, so each download is built here — a file link
 * against the Workspace's download route, an Artifact from content the viewer
 * has read back. The model never sees any of it.
 */
export function OfferedFiles({
  files,
  artifacts,
  scope,
  onOpen,
}: {
  files: OfferedFile[];
  artifacts: StoredArtifact[];
  /** The Workspace each Artifact is read back from; absent withholds the read. */
  scope?: Scope | null;
  /** Opens an Artifact in the Chat's side panel at the version it wrote. */
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
