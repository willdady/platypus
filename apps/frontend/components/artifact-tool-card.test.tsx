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
    deleted: false,
    ...over,
  };
}

vi.mock("@/hooks/use-artifact", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-artifact")>();
  return { ...actual, useStoredArtifact: () => hook.result };
});

import { ArtifactToolCard, ARTIFACT_DELETED_LABEL } from "./artifact-tool-card";

type ArtifactPart = Extract<
  ToolUIPart<CustomUITools>,
  { type: "tool-createArtifact" | "tool-updateArtifact" }
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

function updating(over: Record<string, unknown> = {}) {
  return part({
    type: "tool-updateArtifact",
    state: "output-available",
    input: { id: "artifact-1", edits: [{ old: "1.0", new: "1.1" }] },
    output: { id: "artifact-1", title: "Release notes", version: 2 },
    ...over,
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
  });

  it("opens the Artifact while its content is still streaming", () => {
    const onOpen = vi.fn();
    render(
      <ArtifactToolCard
        toolPart={streaming()}
        scope={{ orgId: "org-1", workspaceId: "ws-1" }}
        onOpen={onOpen}
      />,
    );

    expect(screen.getByRole("button")).toBeEnabled();

    fireEvent.click(screen.getByRole("button"));

    expect(onOpen).toHaveBeenCalledWith({ toolCallId: "call-1" });
  });

  it("opens a failed call so the panel can say it was not saved", () => {
    const onOpen = vi.fn();
    render(
      <ArtifactToolCard
        toolPart={part({
          state: "output-error",
          input: { title: "Release notes", type: "markdown", content: "# 1" },
          errorText: "Artifact content must be at most 512 KB",
        })}
        scope={{ orgId: "org-1", workspaceId: "ws-1" }}
        onOpen={onOpen}
      />,
    );

    fireEvent.click(screen.getByRole("button"));

    expect(onOpen).toHaveBeenCalledWith({ toolCallId: "call-1" });
  });

  it("opens a rejected call so the panel can say it was not saved", () => {
    const onOpen = vi.fn();
    render(
      <ArtifactToolCard
        toolPart={part({
          state: "output-denied",
          input: { title: "Release notes", type: "markdown", content: "# 1" },
          approval: { id: "approval-1", approved: false },
        })}
        scope={{ orgId: "org-1", workspaceId: "ws-1" }}
        onOpen={onOpen}
      />,
    );

    fireEvent.click(screen.getByRole("button"));

    expect(onOpen).toHaveBeenCalledWith({ toolCallId: "call-1" });
  });

  it("does not show a half-written type as if it were the type", () => {
    render(
      <ArtifactToolCard
        toolPart={part({
          state: "input-streaming",
          input: { title: "Release notes", type: "markd" },
        })}
        scope={{ orgId: "org-1", workspaceId: "ws-1" }}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByText("Release notes")).toBeInTheDocument();
    expect(screen.queryByText("Markd")).not.toBeInTheDocument();
    expect(screen.getByText("Artifact")).toBeInTheDocument();
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

  it("draws an update call as a card and opens the version it produced", () => {
    const onOpen = vi.fn();
    hook.result = buildResult({
      data: {
        artifact: { type: "markdown" },
        version: { version: 2 },
      },
    });
    render(
      <ArtifactToolCard
        toolPart={updating()}
        scope={{ orgId: "org-1", workspaceId: "ws-1" }}
        onOpen={onOpen}
      />,
    );

    expect(screen.getByText("Release notes")).toBeInTheDocument();
    expect(screen.getByText(/Markdown · Version 2/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Release notes/ }));

    expect(onOpen).toHaveBeenCalledWith({ id: "artifact-1", version: 2 });
  });

  it("shows an update waiting on its result as updating", () => {
    render(
      <ArtifactToolCard
        toolPart={updating({
          state: "input-streaming",
          output: undefined,
        })}
        scope={{ orgId: "org-1", workspaceId: "ws-1" }}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByText("Updating artifact…")).toBeInTheDocument();
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("shows a deleted state, not an error, when the Artifact is gone", () => {
    hook.result = buildResult({ deleted: true });
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

  it("shows a failed update's own error", () => {
    render(
      <ArtifactToolCard
        toolPart={updating({
          state: "output-available",
          output: {
            error:
              'Edit 1 ("1.0") must match exactly once, but matched 0 times.',
          },
        })}
        scope={{ orgId: "org-1", workspaceId: "ws-1" }}
        onOpen={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/must match exactly once, but matched 0 times/),
    ).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
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
