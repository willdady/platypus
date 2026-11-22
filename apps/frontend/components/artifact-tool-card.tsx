"use client";

import { createElement } from "react";
import type { ToolUIPart } from "ai";
import type { ArtifactType, CustomUITools } from "@platypus/schemas";
import type { Scope } from "@/lib/api-write";
import { cn } from "@/lib/utils";
import {
  getToolIcon,
  ToolStatus,
  toolRowIconSlotClassName,
} from "./ai-elements/tool";
import { artifactTypeLabel } from "@/lib/artifact-file";
import { isArtifactDeleted, useArtifact } from "@/hooks/use-artifact";

type ArtifactToolPart = Extract<
  ToolUIPart<CustomUITools>,
  { type: "tool-createArtifact" }
>;

export const ARTIFACT_DELETED_LABEL = "Artifact deleted";

/**
 * The Chat's Artifact Card: a title, its type and the version the call
 * produced, opening the Artifact in the side panel. The Artifact is read back
 * by id and version so a later deletion reads as deleted rather than as an
 * error; while the call's input streams the Card shows the title it has so far.
 */
export function ArtifactToolCard({
  toolPart,
  scope,
  onOpen,
}: {
  toolPart: ArtifactToolPart;
  /** The Workspace the read is confined to; absent withholds the read. */
  scope?: Scope | null;
  onOpen: (target: { id: string; version: number }) => void;
}) {
  const input: { title?: string; type?: ArtifactType } | undefined =
    toolPart.input;
  const output:
    | { id: string; title: string; version: number }
    | { error: string }
    | undefined = toolPart.output;
  const created = output && "id" in output ? output : undefined;

  const { error } = useArtifact(
    created ? (scope ?? null) : null,
    created?.id,
    created?.version,
  );
  const deleted = created !== undefined && isArtifactDeleted(error);

  const outputError =
    toolPart.errorText ||
    (output && "error" in output ? String(output.error) : undefined);

  const title = created?.title ?? input?.title;
  const type = input?.type;
  const canOpen = created !== undefined && !deleted;

  return (
    <div className="w-full min-w-0">
      <button
        type="button"
        disabled={!canOpen}
        onClick={() => {
          if (created) onOpen({ id: created.id, version: created.version });
        }}
        className={cn(
          "flex w-full min-w-0 items-center gap-3 rounded-lg border bg-card px-3 py-2.5 text-left",
          canOpen
            ? "hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            : "cursor-default",
        )}
      >
        <span className={cn(toolRowIconSlotClassName, "text-muted-foreground")}>
          {createElement(getToolIcon(toolPart.type), { className: "size-4" })}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="min-w-0 truncate font-medium text-sm">
            {deleted ? ARTIFACT_DELETED_LABEL : (title ?? "Creating artifact…")}
          </span>
          <span className="truncate text-muted-foreground text-xs">
            {[
              type ? artifactTypeLabel(type) : undefined,
              created ? `Version ${created.version}` : undefined,
            ]
              .filter(Boolean)
              .join(" · ") || "Artifact"}
          </span>
        </span>
        <ToolStatus state={toolPart.state} />
      </button>
      {outputError && (
        <div className="mt-1 pl-9 text-destructive text-xs">{outputError}</div>
      )}
      {deleted && (
        <div className="mt-1 pl-9 text-muted-foreground text-xs">
          This Artifact has been deleted.
        </div>
      )}
    </div>
  );
}
