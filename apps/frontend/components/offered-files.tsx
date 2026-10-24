"use client";

import {
  DownloadIcon,
  FileArchiveIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileVideoIcon,
  type LucideIcon,
} from "lucide-react";
import { useParams } from "next/navigation";
import { formatFileSize, type PlatypusUIMessage } from "@platypus/schemas";
import { useBackendUrl } from "@/components/auth-provider";
import { Button } from "@/components/ui/button";
import { scopedUrl } from "@/lib/api-write";

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

/**
 * The Sandbox files a finished reply offered for download (ADR-0027), as one
 * tray under it. The tool result holds only the path, so each link is built
 * here, against the Workspace's download route — the model never sees it.
 */
export function OfferedFiles({ files }: { files: OfferedFile[] }) {
  const backendUrl = useBackendUrl();
  const scope = useParams<{ orgId: string; workspaceId: string }>();

  return (
    <ul aria-label="Files" className="flex flex-col gap-2 pl-8">
      {files.map(({ path, size }) => {
        const name = path.split("/").pop() || path;
        const Icon = fileIcon(name);
        return (
          <li
            key={path}
            className="flex items-center gap-3 rounded-lg border bg-card p-3"
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted">
              <Icon className="size-5 text-muted-foreground" />
            </span>
            <div className="min-w-0 flex-1" title={path}>
              <div className="truncate font-medium text-sm">{name}</div>
              <div className="flex gap-2 text-muted-foreground text-xs">
                <span className="min-w-0 truncate font-mono">{path}</span>
                {size !== undefined && (
                  <span className="shrink-0">{formatFileSize(size)}</span>
                )}
              </div>
            </div>
            <div className="flex shrink-0 gap-2">
              {backendUrl && (
                <Button size="sm" asChild>
                  <a
                    href={`${scopedUrl(backendUrl, "sandbox/file", scope)}?${new URLSearchParams({ path })}`}
                  >
                    <DownloadIcon /> Download
                  </a>
                </Button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
