import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ComponentProps } from "react";
import { render, screen, fireEvent } from "@testing-library/react";

const { hook, copy } = vi.hoisted(() => ({
  hook: { result: {} },
  copy: vi.fn(async () => true),
}));

vi.mock("@/hooks/use-artifact", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-artifact")>();
  return { ...actual, useArtifact: () => hook.result };
});
vi.mock("@/lib/clipboard", () => ({ copyWithToast: copy }));
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { id: "u1" }, isPending: false }),
  useBackendUrl: () => "http://test",
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("./artifact-markdown", () => ({
  ArtifactMarkdown: ({ content }: { content: string }) => <pre>{content}</pre>,
  fencedCode: (content: string, language: string) =>
    `\`\`\`${language}\n${content}\n\`\`\``,
}));

import { ArtifactViewer } from "./artifact-viewer";

const markdown = {
  artifact: {
    id: "artifact-1",
    workspaceId: "ws-1",
    sourceChatId: "chat-1",
    title: "Release notes",
    type: "markdown",
    language: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  },
  version: {
    id: "v2",
    artifactId: "artifact-1",
    version: 2,
    content: "# Version two",
    author: "agent",
    createdAt: "2026-01-02T00:00:00.000Z",
  },
};

function renderViewer(
  over: Partial<ComponentProps<typeof ArtifactViewer>> = {},
) {
  return render(
    <ArtifactViewer
      orgId="org-1"
      workspaceId="ws-1"
      artifactId="artifact-1"
      {...over}
    />,
  );
}

beforeEach(() => {
  hook.result = { data: markdown, isLoading: false };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ArtifactViewer", () => {
  it("shows the title, type and version with the rendered preview", () => {
    renderViewer();

    expect(screen.getByText("Release notes")).toBeInTheDocument();
    expect(screen.getByText("Markdown")).toBeInTheDocument();
    expect(screen.getByText(/Version 2/)).toBeInTheDocument();
    expect(screen.getByText("# Version two")).toBeInTheDocument();
  });

  it("switches to the Code tab's source", () => {
    renderViewer();

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Code" }), {
      button: 0,
    });

    expect(screen.getByText(/```markdown/)).toBeInTheDocument();
  });

  it("shows a Mermaid Artifact's source in Code, not a second diagram", () => {
    hook.result = {
      data: {
        ...markdown,
        artifact: { ...markdown.artifact, type: "mermaid" },
        version: { ...markdown.version, content: "graph TD; A-->B;" },
      },
      isLoading: false,
    };
    renderViewer();

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Code" }), {
      button: 0,
    });

    expect(screen.getByText(/```text/)).toBeInTheDocument();
    expect(screen.queryByText(/```mermaid/)).not.toBeInTheDocument();
  });

  it("offers no Preview for HTML and starts on Code", () => {
    hook.result = {
      data: {
        ...markdown,
        artifact: { ...markdown.artifact, type: "html" },
        version: { ...markdown.version, content: "<p>Hi</p>" },
      },
      isLoading: false,
    };
    renderViewer();

    expect(screen.getByRole("tab", { name: "Preview" })).toBeDisabled();
    expect(screen.getByRole("tab", { name: "Code" })).toHaveAttribute(
      "data-state",
      "active",
    );
  });

  it("says an Artifact is deleted rather than showing an error", () => {
    hook.result = { error: { status: 404 }, isLoading: false };
    renderViewer();

    expect(
      screen.getByText("This Artifact has been deleted."),
    ).toBeInTheDocument();
  });

  it("copies and downloads the current version's source", () => {
    const createObjectURL = vi.fn(() => "blob:artifact");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    renderViewer();

    fireEvent.click(
      screen.getByRole("button", { name: "Copy Artifact source" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Download Artifact" }));

    expect(copy).toHaveBeenCalledWith("# Version two", "Copied");
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:artifact");
  });

  it("closes from the header", () => {
    const onClose = vi.fn();
    renderViewer({ onClose });

    fireEvent.click(screen.getByRole("button", { name: "Close Artifact" }));

    expect(onClose).toHaveBeenCalledOnce();
  });
});
