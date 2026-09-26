"use client";

import { DownloadIcon, FileDownIcon } from "lucide-react";
import { useParams } from "next/navigation";
import type { ToolUIPart } from "ai";
import { type CustomUITools } from "@platypus/backend/src/types";
import { useBackendUrl } from "@/components/auth-provider";
import { Button } from "@/components/ui/button";
import { scopedUrl } from "@/lib/api-write";
import {
  ToolStatus,
  toolRowClassName,
  toolRowIconSlotClassName,
} from "./ai-elements/tool";

type FsDownloadToolPart = Extract<
  ToolUIPart<CustomUITools>,
  { type: "tool-fsDownload" }
>;

/**
 * A Sandbox file the model offered for download (ADR-0027). The tool result
 * holds only the path, so the link is built here, against the Workspace's
 * download route — the model never sees it. Errors never reach this card;
 * they render through the generic tool renderer.
 */
export const FsDownloadTool = ({
  toolPart,
}: {
  toolPart: FsDownloadToolPart;
}) => {
  const backendUrl = useBackendUrl();
  const scope = useParams<{ orgId: string; workspaceId: string }>();
  const path = toolPart.output?.path ?? toolPart.input?.path;

  return (
    <div className={toolRowClassName}>
      <span className={toolRowIconSlotClassName}>
        <FileDownIcon className="size-4" />
      </span>
      <span className="min-w-0 truncate">{path}</span>
      {toolPart.state === "output-available" && backendUrl ? (
        <Button variant="outline" size="sm" asChild>
          <a
            href={`${scopedUrl(backendUrl, "sandbox/file", scope)}?${new URLSearchParams({ path: toolPart.output.path })}`}
          >
            <DownloadIcon /> Download
          </a>
        </Button>
      ) : (
        <ToolStatus state={toolPart.state} />
      )}
    </div>
  );
};
