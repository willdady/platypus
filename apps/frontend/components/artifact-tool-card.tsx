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
import { isArtifactDeleted, useArtifact } from "@/hooks/use-artifact";
import type { ArtifactLive } from "./artifact-viewer";

type ArtifactToolPart = Extract<
  ToolUIPart<CustomUITools>,
  { type: "tool-createArtifact" }
>;

/** The input a `createArtifact` call carries; partial while it streams. */
type ArtifactInput = Partial<{
  title: string;
  type: ArtifactType;
  language: string;
  content: string;
}>;

/** The stored Artifact a completed `createArtifact` call produced. */
export type StoredArtifact = { id: string; title: string; version: number };

/** What the Card asks the Chat to open in the side panel. */
export type ArtifactOpenTarget =
  { id: string; version: number } | { toolCallId: string };

export const ARTIFACT_DELETED_LABEL = "Artifact deleted";

export function artifactInput(toolPart: ArtifactToolPart): ArtifactInput {
  return toolPart.input ?? {};
}

/**
 * The Artifact's type once it is a complete member. A streamed input is parsed
 * from partial JSON, so `type` can be half a word; an unknown value is treated
 * as not yet written rather than shown as a type.
 */
export function artifactTypeOf(value: unknown): ArtifactType | undefined {
  const parsed = artifactTypeSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** The stored Artifact a completed call produced, or `undefined` while it runs. */
export function storedArtifactOf(
  toolPart: ArtifactToolPart,
): StoredArtifact | undefined {
  const output = toolPart.output;
  return output && "id" in output ? output : undefined;
}

/** Why a call wrote nothing: a validation error, a rejection or a failure. */
export function artifactFailureOf(
  toolPart: ArtifactToolPart,
): string | undefined {
  const reported = toolErrorText(toolPart);
  if (reported) return reported;
  const output = toolPart.output;
  if (output && "error" in output) return String(output.error);
  return undefined;
}

/** Whether the call wrote nothing: it failed, was denied, or was rejected. */
function partStateFailed(toolPart: ArtifactToolPart): boolean {
  if (toolPart.state === "output-error" || toolPart.state === "output-denied") {
    return true;
  }
  return toolPart.state === "approval-responded" && !toolPart.approval.approved;
}

/**
 * The content a Chat panel shows for a call that has not been stored yet: the
 * partial input while it runs, or the same content held back as failed when the
 * call wrote nothing. A stored version always wins in the viewer, so this is
 * only what fills the panel until that read lands.
 */
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

/**
 * Finds a `createArtifact` call in the transcript by its id. The Chat keeps
 * only the call id in its open-panel state, so the part it resolves to keeps
 * updating as the call streams and completes.
 */
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

/**
 * The Chat's Artifact Card: a title, its type and the version the call
 * produced, opening the Artifact in the side panel. While the call's input
 * streams the Card can be opened too, so the panel shows the content as it
 * arrives. Once the call completes the Artifact is read back by id and version,
 * so a later deletion reads as deleted rather than as an error.
 */
export function ArtifactToolCard({
  toolPart,
  scope,
  onOpen,
}: {
  toolPart: ArtifactToolPart;
  /** The Workspace the read is confined to; absent withholds the read. */
  scope?: Scope | null;
  onOpen: (target: ArtifactOpenTarget) => void;
}) {
  const input = artifactInput(toolPart);
  const created = storedArtifactOf(toolPart);
  const failure = artifactFailureOf(toolPart);

  const { error } = useArtifact(
    created ? (scope ?? null) : null,
    created?.id,
    created?.version,
  );
  const deleted = created !== undefined && isArtifactDeleted(error);

  const title = created?.title ?? input.title;
  const type = artifactTypeOf(input.type);
  const canOpen = !deleted;

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
      {failure && (
        <div className="mt-1 pl-9 text-destructive text-xs">{failure}</div>
      )}
      {deleted && (
        <div className="mt-1 pl-9 text-muted-foreground text-xs">
          This Artifact has been deleted.
        </div>
      )}
    </div>
  );
}
