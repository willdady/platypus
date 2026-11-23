import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

/**
 * The split's own seam: the primitive is stubbed to the props and callbacks
 * this component hands it, so the pixel rules and the remembered width can be
 * pinned without laying out a browser.
 */
const { group } = vi.hoisted(() => ({
  group: {
    setLayout: vi.fn(),
    onLayoutChanged: null as
      | null
      | ((
          layout: Record<string, number>,
          meta: { isUserInteraction: boolean },
        ) => void),
  },
}));

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({
    children,
    groupRef,
    onLayoutChanged,
    orientation,
  }: {
    children?: ReactNode;
    groupRef?: { current: unknown };
    onLayoutChanged?: typeof group.onLayoutChanged;
    orientation?: string;
  }) => {
    group.onLayoutChanged = onLayoutChanged ?? null;
    if (groupRef) {
      groupRef.current = { setLayout: group.setLayout };
    }
    return (
      <div data-testid="group" data-orientation={orientation}>
        {children}
      </div>
    );
  },
  ResizablePanel: ({
    children,
    id,
    defaultSize,
    minSize,
  }: {
    children?: ReactNode;
    id?: string;
    defaultSize?: string;
    minSize?: string;
  }) => (
    <div
      data-testid={`panel-${id}`}
      data-default-size={defaultSize}
      data-min-size={minSize}
    >
      {children}
    </div>
  ),
  ResizableHandle: ({
    onDoubleClick,
  }: {
    onDoubleClick?: React.DOMAttributes<HTMLButtonElement>["onDoubleClick"];
  }) => (
    <button type="button" data-testid="handle" onDoubleClick={onDoubleClick} />
  ),
}));

import { ChatArtifactSplit } from "./chat-artifact-split";
import { ARTIFACT_CHAT_WIDTH_KEY } from "@/lib/artifact-panel-split";
import {
  captureRowResize,
  layOutRow,
  stubWideViewport,
} from "@/test/panel-split-harness";

function renderSplit({
  wide = true,
  width = 1440,
  panel = <div>Artifact</div>,
  fullScreen = false,
}: {
  wide?: boolean;
  width?: number;
  panel?: ReactNode | null;
  fullScreen?: boolean;
} = {}) {
  stubWideViewport(wide);
  layOutRow(width);
  return render(
    <ChatArtifactSplit panel={panel} fullScreen={fullScreen}>
      <div>Chat</div>
    </ChatArtifactSplit>,
  );
}

beforeEach(() => {
  localStorage.clear();
  group.setLayout.mockClear();
});

describe("the Chat and Artifact panel split", () => {
  it("gives a 1440px row 896px to the Chat and the rest to the panel", () => {
    renderSplit();

    expect(screen.getByTestId("panel-chat")).toHaveAttribute(
      "data-default-size",
      "62.22%",
    );
    expect(screen.getByTestId("panel-chat")).toHaveAttribute(
      "data-min-size",
      "25%",
    );
    expect(screen.getByTestId("panel-artifact")).toHaveAttribute(
      "data-min-size",
      "27.78%",
    );
  });

  it("clamps the Chat to its minimum at the narrowest splittable row", () => {
    renderSplit({ width: 760 });

    expect(screen.getByTestId("panel-chat")).toHaveAttribute(
      "data-default-size",
      "47.37%",
    );
    expect(screen.getByTestId("panel-chat")).toHaveAttribute(
      "data-min-size",
      "47.37%",
    );
    expect(screen.getByTestId("panel-artifact")).toHaveAttribute(
      "data-min-size",
      "52.63%",
    );
  });

  it("covers the Chat on a row too narrow for both minimums", () => {
    renderSplit({ width: 700 });

    expect(screen.getByTestId("panel-chat")).toHaveAttribute(
      "data-default-size",
      "0%",
    );
    expect(screen.getByTestId("panel-artifact")).toHaveAttribute(
      "data-default-size",
      "100%",
    );
    expect(screen.getByRole("complementary")).toHaveAttribute(
      "data-presentation",
      "overlay",
    );
    expect(screen.getByRole("complementary")).toHaveClass(
      "absolute",
      "inset-0",
      "z-20",
    );
  });

  it("hands a wider row's spare width to the panel", () => {
    const resizeRow = captureRowResize();
    renderSplit({ width: 1440 });
    group.setLayout.mockClear();

    layOutRow(2560);
    act(() => resizeRow());

    expect(group.setLayout).toHaveBeenCalledWith({ chat: 35, artifact: 65 });
  });

  it("keeps a dragged width while the row changes size", () => {
    const resizeRow = captureRowResize();
    renderSplit({ width: 1440 });
    group.onLayoutChanged?.(
      { chat: 50, artifact: 50 },
      { isUserInteraction: true },
    );
    group.setLayout.mockClear();

    layOutRow(2560);
    act(() => resizeRow());

    expect(group.setLayout).toHaveBeenCalledWith({
      chat: 28.13,
      artifact: 71.87,
    });
  });

  it("leaves the Chat whole while no Artifact is open", () => {
    renderSplit({ panel: null });

    expect(screen.queryByTestId("group")).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.getByText("Chat")).toBeInTheDocument();
  });

  it("covers the Chat below lg instead of splitting the row", () => {
    renderSplit({ wide: false });

    expect(screen.getByText("Chat")).toBeInTheDocument();
    expect(screen.getByRole("complementary")).toHaveAttribute(
      "data-presentation",
      "overlay",
    );
    expect(screen.getByRole("complementary")).toHaveClass(
      "absolute",
      "inset-0",
      "z-20",
    );
  });

  it("covers the window in full screen", () => {
    renderSplit({ fullScreen: true });

    expect(screen.getByRole("complementary")).toHaveClass(
      "fixed",
      "inset-0",
      "z-50",
    );
  });
});

describe("the remembered split", () => {
  it("restores the width saved in this browser", () => {
    localStorage.setItem(ARTIFACT_CHAT_WIDTH_KEY, "600");

    renderSplit();

    expect(group.setLayout).toHaveBeenCalledWith({
      chat: 41.67,
      artifact: 58.33,
    });
  });

  it("applies the default when nothing was saved", () => {
    renderSplit();

    expect(group.setLayout).toHaveBeenCalledWith({
      chat: 62.22,
      artifact: 37.78,
    });
  });

  it("saves a drag as the Chat's width in pixels", () => {
    renderSplit();

    group.onLayoutChanged?.(
      { chat: 50, artifact: 50 },
      {
        isUserInteraction: true,
      },
    );

    expect(localStorage.getItem(ARTIFACT_CHAT_WIDTH_KEY)).toBe("720");
  });

  it("ignores a layout the User did not choose", () => {
    renderSplit();

    group.onLayoutChanged?.(
      { chat: 50, artifact: 50 },
      {
        isUserInteraction: false,
      },
    );

    expect(localStorage.getItem(ARTIFACT_CHAT_WIDTH_KEY)).toBeNull();
  });

  it("resets to the default split and forgets the width on a double-click", () => {
    localStorage.setItem(ARTIFACT_CHAT_WIDTH_KEY, "600");
    renderSplit();
    group.setLayout.mockClear();

    fireEvent.doubleClick(screen.getByTestId("handle"));

    expect(localStorage.getItem(ARTIFACT_CHAT_WIDTH_KEY)).toBeNull();
    expect(group.setLayout).toHaveBeenCalledWith({
      chat: 62.22,
      artifact: 37.78,
    });
  });
});
