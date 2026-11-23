"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  GroupImperativeHandle,
  Layout,
  LayoutChangedMeta,
} from "react-resizable-panels";
import { useMediaQuery } from "@/hooks/use-media-query";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  artifactPanelSplit,
  chatWidthFromPercent,
  clearStoredChatWidth,
  readStoredChatWidth,
  rowFitsSplit,
  storeChatWidth,
} from "@/lib/artifact-panel-split";
import { cn } from "@/lib/utils";

/** Tailwind's `lg`: the width at which the panel sits beside the Chat. */
const SIDE_PANEL_QUERY = "(min-width: 1024px)";
/** The row that holds the Chat and the panel; measured, not the viewport. */
const ROW_CLASS = "relative flex size-full min-h-0 overflow-hidden";
const CHAT_PANEL_ID = "chat";
const ARTIFACT_PANEL_ID = "artifact";

/**
 * The Chat and an open Artifact panel in one row. From `lg` up, on a row wide
 * enough for both minimums, the two share the row with a divider between them:
 * the Chat starts at `min(896, rowWidth − 400)` and the panel takes the rest,
 * and either can be dragged between the minimums, remembered in this browser,
 * and reset with a double-click. Below `lg`, or on a row too narrow to hold
 * both minimums, the panel covers the Chat, exactly as it did before the split
 * existed.
 */
export function ChatArtifactSplit({
  panel,
  fullScreen,
  children,
}: {
  /** The Artifact panel's content; `null` while no Artifact is open. */
  panel: ReactNode | null;
  /** The panel covers the whole window rather than sharing the row. */
  fullScreen: boolean;
  /** The Chat's own column. */
  children: ReactNode;
}) {
  const wide = useMediaQuery(SIDE_PANEL_QUERY);
  const panelOpen = Boolean(panel);
  const rowRef = useRef<HTMLDivElement>(null);
  const groupRef = useRef<GroupImperativeHandle | null>(null);
  const [rowWidth, setRowWidth] = useState(0);
  // The width the User dragged to, or read from this browser. `null` means the
  // default split, which follows the row's width.
  const chosenWidth = useRef<number | null>(null);

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const measure = () => setRowWidth(row.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, []);

  // Apply the split whenever the panel joins the row or the row changes size,
  // so a wider window hands the spare width to the panel rather than growing
  // the Chat past its default and a remembered width holds its pixels.
  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    if (!panelOpen) {
      wasOpen.current = false;
      return;
    }
    if (!wide || !rowFitsSplit(rowWidth)) return;
    if (!wasOpen.current) {
      wasOpen.current = true;
      const stored = readStoredChatWidth();
      if (stored !== null) chosenWidth.current = stored;
    }
    const apply = () => {
      const split = artifactPanelSplit(
        rowWidth,
        chosenWidth.current ?? undefined,
      );
      groupRef.current?.setLayout({
        [CHAT_PANEL_ID]: split.chatPercent,
        [ARTIFACT_PANEL_ID]: split.panelPercent,
      });
    };
    apply();
    // The primitive derives its percentage constraints from the row's new
    // width in its own observer, which may land after this effect. A frame
    // later the split is applied again against those fresh constraints, so a
    // remembered pixel width is not clamped to the old row's minimum.
    const frame = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(frame);
  }, [panelOpen, wide, rowWidth]);

  const handleLayoutChanged = useCallback(
    (layout: Layout, meta: LayoutChangedMeta) => {
      if (!meta.isUserInteraction || rowWidth <= 0) return;
      const chatPercent = layout[CHAT_PANEL_ID];
      if (typeof chatPercent !== "number") return;
      chosenWidth.current = chatWidthFromPercent(chatPercent, rowWidth);
      storeChatWidth(chosenWidth.current);
    },
    [rowWidth],
  );

  // The split primitive resets on a double-click too; its reset is off so the
  // stored width is cleared here rather than written back by the reset.
  const resetSplit = useCallback(() => {
    chosenWidth.current = null;
    clearStoredChatWidth();
    const reset = artifactPanelSplit(rowWidth);
    groupRef.current?.setLayout({
      [CHAT_PANEL_ID]: reset.chatPercent,
      [ARTIFACT_PANEL_ID]: reset.panelPercent,
    });
  }, [rowWidth]);

  const splitting = wide && rowFitsSplit(rowWidth);
  const split = artifactPanelSplit(rowWidth);
  const aside = panel && (
    <aside
      className={cn(
        "flex flex-col bg-background",
        fullScreen
          ? "fixed inset-0 z-50"
          : splitting
            ? "size-full"
            : "absolute inset-0 z-20 border-l",
      )}
    >
      {panel}
    </aside>
  );

  if (!panel) {
    return (
      <div ref={rowRef} className={ROW_CLASS}>
        {children}
      </div>
    );
  }

  // Before the row has been measured there is nothing to divide, and waiting
  // for the measurement keeps the panel from mounting once as an overlay and
  // again beside the Chat, which would reset its tabs and version.
  if (wide && rowWidth <= 0) {
    return (
      <div ref={rowRef} className={ROW_CLASS}>
        {children}
      </div>
    );
  }

  if (!splitting) {
    return (
      <div ref={rowRef} className={ROW_CLASS}>
        {children}
        {aside}
      </div>
    );
  }

  return (
    <div ref={rowRef} className={ROW_CLASS}>
      <ResizablePanelGroup
        orientation="horizontal"
        groupRef={groupRef}
        onLayoutChanged={handleLayoutChanged}
        className="size-full"
      >
        <ResizablePanel
          id={CHAT_PANEL_ID}
          defaultSize={`${split.chatPercent}%`}
          minSize={`${split.chatMinPercent}%`}
          style={{ overflow: "hidden" }}
        >
          {children}
        </ResizablePanel>
        <ResizableHandle
          withHandle
          aria-label="Resize the Artifact panel"
          disableDoubleClick
          onDoubleClick={resetSplit}
        />
        <ResizablePanel
          id={ARTIFACT_PANEL_ID}
          minSize={`${split.panelMinPercent}%`}
          style={{ overflow: "hidden" }}
        >
          {aside}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
