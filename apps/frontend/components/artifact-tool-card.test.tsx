import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ToolUIPart } from "ai";
import type { CustomUITools } from "@platypus/schemas";

const { hook } = vi.hoisted(() => ({
  hook: {
    result: {} as ReturnType<typeof buildResult>,
  },
}));

function buildResult(over: Record<string, unknown> = {}) {
  return {
    data: undefined,
    error: undefined,
    isLoading: false,
    ...over,
  };
}

vi.mock("@/hooks/use-artifact", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-artifact")>();
  return { ...actual, useArtifact: () => hook.result };
});

import { ArtifactToolCard, ARTIFACT_DELETED_LABEL } from "./artifact-tool-card";

type ArtifactPart = Extract<
  ToolUIPart<CustomUITools>,
  { type: "tool-createArtifact" }
>;

function part(over: Record<string, unknown>): ArtifactPart {
  return {
    type: "tool-createArtifact",
    toolCallId: "call-1",
    ...over,
  } as unknown as ArtifactPart;
}

function streaming() {
  return part({
    state: "input-streaming",
    input: { title: "Release notes", type: "markdown" },
  });
}

function completed() {
  return part({
    state: "output-available",
    input: {
      title: "Release notes",
      type: "markdown",
      content: "# 1.0",
    },
    output: { id: "artifact-1", title: "Release notes", version: 1 },
  });
}

beforeEach(() => {
  hook.result = buildResult();
});

describe("ArtifactToolCard", () => {
  it("shows the title and type while the input streams", () => {
    render(
      <ArtifactToolCard
        toolPart={streaming()}
        scope={{ orgId: "org-1", workspaceId: "ws-1" }}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByText("Release notes")).toBeInTheDocument();
    expect(screen.getByText("Markdown")).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("opens the version the call produced once it completes", () => {
    const onOpen = vi.fn();
    render(
      <ArtifactToolCard
        toolPart={completed()}
        scope={{ orgId: "org-1", workspaceId: "ws-1" }}
        onOpen={onOpen}
      />,
    );

    expect(screen.getByText(/Version 1/)).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button"));

    expect(onOpen).toHaveBeenCalledWith({ id: "artifact-1", version: 1 });
  });

  it("shows a deleted state, not an error, when the Artifact is gone", () => {
    hook.result = buildResult({ error: { status: 404 } });
    render(
      <ArtifactToolCard
        toolPart={completed()}
        scope={{ orgId: "org-1", workspaceId: "ws-1" }}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByText(ARTIFACT_DELETED_LABEL)).toBeInTheDocument();
    expect(
      screen.getByText("This Artifact has been deleted."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button")).toBeDisabled();
    expect(screen.queryByText("Error")).not.toBeInTheDocument();
  });

  it("shows the tool's own error", () => {
    render(
      <ArtifactToolCard
        toolPart={part({
          state: "output-error",
          input: { title: "Too big", type: "markdown" },
          errorText: "Artifact content must be at most 512 KB",
        })}
        scope={{ orgId: "org-1", workspaceId: "ws-1" }}
        onOpen={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Artifact content must be at most 512 KB"),
    ).toBeInTheDocument();
  });
});
