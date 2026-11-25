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

const SIDE_PANEL_QUERY = "(min-width: 1024px)";
const ROW_CLASS = "relative flex size-full min-h-0 overflow-hidden";
const CHAT_PANEL_ID = "chat";
const ARTIFACT_PANEL_ID = "artifact";

export function ChatArtifactSplit({
  panel,
  fullScreen,
  children,
}: {
  panel: ReactNode | null;
  fullScreen: boolean;
  children: ReactNode;
}) {
  const wide = useMediaQuery(SIDE_PANEL_QUERY);
  const panelOpen = Boolean(panel);
  const rowRef = useRef<HTMLDivElement>(null);
  const groupRef = useRef<GroupImperativeHandle | null>(null);
  const [rowWidth, setRowWidth] = useState(0);
  // why: null means the default split, which follows the row's width
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

  const splitting = wide && rowFitsSplit(rowWidth);
  // why: an unmeasured row would mount the Viewer twice and reset its tabs
  const showPanel = panelOpen && (!wide || rowWidth > 0);
  const splitShown = showPanel && splitting;
  const overlay = showPanel && !splitting;

  // why: a wider row gives spare width to the panel, not past the Chat's default
  const wasSplitting = useRef(false);
  useLayoutEffect(() => {
    if (!panelOpen) {
      wasSplitting.current = false;
      // why: applied twice; the closed panel's 0% minimum lands a frame later
      const reset = () =>
        groupRef.current?.setLayout({
          [CHAT_PANEL_ID]: 100,
          [ARTIFACT_PANEL_ID]: 0,
        });
      reset();
      const frame = requestAnimationFrame(reset);
      return () => cancelAnimationFrame(frame);
    }
    if (wide && rowWidth <= 0) return;
    if (splitting && !wasSplitting.current) {
      wasSplitting.current = true;
      const stored = readStoredChatWidth();
      if (stored !== null) chosenWidth.current = stored;
    }
    if (!splitting) wasSplitting.current = false;
    const apply = () => {
      if (!splitting) {
        groupRef.current?.setLayout({
          [CHAT_PANEL_ID]: 0,
          [ARTIFACT_PANEL_ID]: 100,
        });
        return;
      }
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
    // why: applied again a frame later so a remembered width isn't clamped
    const frame = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(frame);
  }, [panelOpen, wide, rowWidth, splitting]);

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

  // why: reset is off, so a double-click clears the stored width instead of rewriting it
  const resetSplit = useCallback(() => {
    chosenWidth.current = null;
    clearStoredChatWidth();
    const reset = artifactPanelSplit(rowWidth);
    groupRef.current?.setLayout({
      [CHAT_PANEL_ID]: reset.chatPercent,
      [ARTIFACT_PANEL_ID]: reset.panelPercent,
    });
  }, [rowWidth]);

  const split = artifactPanelSplit(rowWidth);
  const chatPercent = splitShown
    ? `${split.chatPercent}%`
    : overlay
      ? "0%"
      : "100%";
  const panelPercent = splitShown
    ? `${split.panelPercent}%`
    : showPanel
      ? "100%"
      : "0%";
  const chatMinPercent = splitShown ? `${split.chatMinPercent}%` : "0%";
  const panelMinPercent = splitShown ? `${split.panelMinPercent}%` : "0%";

  const aside = showPanel && (
    <aside
      data-presentation={
        fullScreen ? "full-screen" : overlay ? "overlay" : "split"
      }
      className={cn(
        "flex flex-col bg-background",
        fullScreen
          ? "fixed inset-0 z-50"
          : overlay
            ? "absolute inset-0 z-20 border-l"
            : "size-full",
      )}
    >
      {panel}
    </aside>
  );

  // why: the divider mounts only while split; a hidden one is still focusable
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
          defaultSize={chatPercent}
          minSize={chatMinPercent}
          style={{ overflow: "hidden" }}
        >
          {children}
        </ResizablePanel>
        {splitShown && (
          <ResizableHandle
            withHandle
            aria-label="Resize the Artifact panel"
            disableDoubleClick
            onDoubleClick={resetSplit}
          />
        )}
        <ResizablePanel
          id={ARTIFACT_PANEL_ID}
          defaultSize={panelPercent}
          minSize={panelMinPercent}
          style={{ overflow: "hidden" }}
        >
          {aside}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
