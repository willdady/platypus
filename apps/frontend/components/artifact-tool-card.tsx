"use client";

import { createElement } from "react";
import type { ToolUIPart } from "ai";
import type {
  ArtifactType,
  CustomUITools,
  PlatypusUIMessage,
} from "@platypus/schemas";
import { artifactTypeSchema } from "@platypus/schemas";
import type { Scope } from "@/lib/api-write";
import { cn } from "@/lib/utils";
import {
  getToolIcon,
  ToolStatus,
  toolRowIconSlotClassName,
} from "./ai-elements/tool";
import { artifactTypeLabel } from "@/lib/artifact-file";
import { toolErrorText } from "@/lib/message-parts";
import { useStoredArtifact } from "@/hooks/use-artifact";
import type { ArtifactLive } from "./artifact-viewer";

type ArtifactToolPart = Extract<
  ToolUIPart<CustomUITools>,
  { type: "tool-createArtifact" | "tool-updateArtifact" }
>;

type MessagePart = NonNullable<PlatypusUIMessage["parts"]>[number];

type ArtifactInput = Partial<{
  title: string;
  type: ArtifactType;
  language: string;
  content: string;
}>;

export type StoredArtifact = { id: string; title: string; version: number };

export function isArtifactToolPart(
  part: MessagePart,
): part is ArtifactToolPart {
  return (
    part.type === "tool-createArtifact" || part.type === "tool-updateArtifact"
  );
}

export type ArtifactOpenTarget =
  { id: string; version: number } | { toolCallId: string };

export const ARTIFACT_DELETED_LABEL = "Artifact deleted";
export const ARTIFACT_DELETED_DETAIL = "This Artifact has been deleted.";

export function artifactInput(toolPart: ArtifactToolPart): ArtifactInput {
  return toolPart.type === "tool-createArtifact" ? (toolPart.input ?? {}) : {};
}

export function artifactTypeOf(value: unknown): ArtifactType | undefined {
  const parsed = artifactTypeSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function storedArtifactOf(
  toolPart: ArtifactToolPart,
): StoredArtifact | undefined {
  const output = toolPart.output;
  return output && "id" in output ? output : undefined;
}

export function replyArtifacts(
  parts: readonly MessagePart[],
): StoredArtifact[] {
  const byId = new Map<string, StoredArtifact>();
  for (const part of parts) {
    if (!isArtifactToolPart(part)) continue;
    const stored = storedArtifactOf(part);
    if (stored === undefined) continue;
    const listed = byId.get(stored.id);
    if (listed === undefined || stored.version > listed.version) {
      byId.set(stored.id, stored);
    }
  }
  return [...byId.values()];
}

export function artifactFailureOf(
  toolPart: ArtifactToolPart,
): string | undefined {
  const reported = toolErrorText(toolPart);
  if (reported) return reported;
  const output = toolPart.output;
  if (output && "error" in output) return String(output.error);
  return undefined;
}

function partStateFailed(toolPart: ArtifactToolPart): boolean {
  if (toolPart.state === "output-error" || toolPart.state === "output-denied") {
    return true;
  }
  return toolPart.state === "approval-responded" && !toolPart.approval.approved;
}

export function artifactLiveFromPart(toolPart: ArtifactToolPart): ArtifactLive {
  const input = artifactInput(toolPart);
  const error = artifactFailureOf(toolPart);
  const failed = error !== undefined || partStateFailed(toolPart);
  return {
    status: failed ? "failed" : "streaming",
    title: input.title,
    type: artifactTypeOf(input.type),
    language: input.language ?? null,
    content: typeof input.content === "string" ? input.content : "",
    ...(error === undefined ? {} : { error }),
  };
}

export function findArtifactToolPart(
  messages: PlatypusUIMessage[],
  toolCallId: string,
): ArtifactToolPart | undefined {
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool-createArtifact" && part.toolCallId === toolCallId)
        return part;
    }
  }
  return undefined;
}

export function ArtifactToolCard({
  toolPart,
  scope,
  onOpen,
}: {
  toolPart: ArtifactToolPart;
  scope?: Scope | null;
  onOpen: (target: ArtifactOpenTarget) => void;
}) {
  const updating = toolPart.type === "tool-updateArtifact";
  const input = artifactInput(toolPart);
  const created = storedArtifactOf(toolPart);
  const failure = artifactFailureOf(toolPart);

  const { data, deleted } = useStoredArtifact(created, scope);

  const title = created?.title ?? input.title;
  const type = artifactTypeOf(input.type) ?? data?.artifact.type;
  const canOpen = !deleted && (created !== undefined || !updating);

  return (
    <div className="w-full min-w-0">
      <button
        type="button"
        disabled={!canOpen}
        onClick={() => {
          onOpen(
            created
              ? { id: created.id, version: created.version }
              : { toolCallId: toolPart.toolCallId },
          );
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
            {deleted
              ? ARTIFACT_DELETED_LABEL
              : (title ??
                (updating ? "Updating artifact…" : "Creating artifact…"))}
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
      {failure && (
        <div className="mt-1 pl-9 text-destructive text-xs">{failure}</div>
      )}
      {deleted && (
        <div className="mt-1 pl-9 text-muted-foreground text-xs">
          {ARTIFACT_DELETED_DETAIL}
        </div>
      )}
    </div>
  );
}
