import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ComponentProps } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { formatDateTime } from "@/lib/format-date";

const { artifactHook, versionsHook, copy } = vi.hoisted(() => ({
  artifactHook: vi.fn(),
  versionsHook: vi.fn(),
  copy: vi.fn(async () => true),
}));

vi.mock("@/hooks/use-artifact", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-artifact")>();
  return {
    ...actual,
    useArtifact: (...args: Parameters<typeof artifactHook>) =>
      artifactHook(...args),
    useArtifactVersions: (...args: Parameters<typeof versionsHook>) =>
      versionsHook(...args),
  };
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
import { selectOption, setupUser } from "@/test/test-utils";

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

const firstVersion = {
  artifact: markdown.artifact,
  version: {
    id: "v1",
    artifactId: "artifact-1",
    version: 1,
    content: "# Version one",
    author: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
};

const versionList = {
  results: [
    {
      id: "v2",
      artifactId: "artifact-1",
      version: 2,
      author: "agent",
      createdAt: "2026-01-02T00:00:00.000Z",
    },
    {
      id: "v1",
      artifactId: "artifact-1",
      version: 1,
      author: "user",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ],
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
  artifactHook.mockReset();
  artifactHook.mockReturnValue({ data: markdown, isLoading: false });
  versionsHook.mockReset();
  versionsHook.mockReturnValue({ data: versionList, isLoading: false });
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
    expect(screen.queryByText("Read-only")).not.toBeInTheDocument();
  });

  it("shows each version's number, author and time in the picker", async () => {
    renderViewer();

    const user = setupUser();
    const trigger = screen.getByRole("combobox", { name: "Artifact version" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");

    expect(
      await screen.findByRole("option", {
        name: `Version 2 · Agent · ${formatDateTime("2026-01-02T00:00:00.000Z")}`,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", {
        name: `Version 1 · You · ${formatDateTime("2026-01-01T00:00:00.000Z")}`,
      }),
    ).toBeInTheDocument();
  });

  it("opens the version a Chat Card named, and marks it read-only", () => {
    artifactHook.mockImplementation(
      (_scope: unknown, _id: string, version?: number) => ({
        data: version === 1 ? firstVersion : markdown,
        isLoading: false,
      }),
    );
    renderViewer({ version: 1 });

    expect(artifactHook).toHaveBeenCalledWith(
      { orgId: "org-1", workspaceId: "ws-1" },
      "artifact-1",
      1,
    );
    expect(screen.getByText("# Version one")).toBeInTheDocument();
    expect(screen.getByText("Read-only")).toBeInTheDocument();
  });

  it("reads an earlier version the reader picks, and marks it read-only", async () => {
    artifactHook.mockImplementation(
      (_scope: unknown, _id: string, version?: number) => ({
        data: version === 1 ? firstVersion : markdown,
        isLoading: false,
      }),
    );
    renderViewer({ version: 2 });

    await selectOption(
      "Version 2",
      `Version 1 · You · ${formatDateTime("2026-01-01T00:00:00.000Z")}`,
    );

    expect(artifactHook).toHaveBeenLastCalledWith(
      { orgId: "org-1", workspaceId: "ws-1" },
      "artifact-1",
      1,
    );
    expect(screen.getByText("# Version one")).toBeInTheDocument();
    expect(screen.getByText("Read-only")).toBeInTheDocument();
  });

  // The full-page view mounts the viewer with no version, so it opens on the
  // latest version and the picker is the only way to a history entry.
  it("opens on the latest version when mounted without one, and picks an older", async () => {
    artifactHook.mockImplementation(
      (_scope: unknown, _id: string, version?: number) => ({
        data: version === 1 ? firstVersion : markdown,
        isLoading: false,
      }),
    );
    renderViewer();

    expect(artifactHook).toHaveBeenCalledWith(
      { orgId: "org-1", workspaceId: "ws-1" },
      "artifact-1",
      undefined,
    );
    expect(screen.getByText("# Version two")).toBeInTheDocument();
    expect(screen.queryByText("Read-only")).not.toBeInTheDocument();

    await selectOption(
      "Version 2",
      `Version 1 · You · ${formatDateTime("2026-01-01T00:00:00.000Z")}`,
    );

    expect(artifactHook).toHaveBeenLastCalledWith(
      { orgId: "org-1", workspaceId: "ws-1" },
      "artifact-1",
      1,
    );
    expect(screen.getByText("# Version one")).toBeInTheDocument();
    expect(screen.getByText("Read-only")).toBeInTheDocument();
  });

  it("switches to the Code tab's source", () => {
    renderViewer();

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Code" }), {
      button: 0,
    });

    expect(screen.getByText(/```markdown/)).toBeInTheDocument();
  });

  it("shows a Mermaid Artifact's source in Code, not a second diagram", () => {
    artifactHook.mockReturnValue({
      data: {
        ...markdown,
        artifact: { ...markdown.artifact, type: "mermaid" },
        version: { ...markdown.version, content: "graph TD; A-->B;" },
      },
      isLoading: false,
    });
    renderViewer();

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Code" }), {
      button: 0,
    });

    expect(screen.getByText(/```text/)).toBeInTheDocument();
    expect(screen.queryByText(/```mermaid/)).not.toBeInTheDocument();
  });

  it("offers no Preview for HTML and starts on Code", () => {
    artifactHook.mockReturnValue({
      data: {
        ...markdown,
        artifact: { ...markdown.artifact, type: "html" },
        version: { ...markdown.version, content: "<p>Hi</p>" },
      },
      isLoading: false,
    });
    renderViewer();

    expect(screen.getByRole("tab", { name: "Preview" })).toBeDisabled();
    expect(screen.getByRole("tab", { name: "Code" })).toHaveAttribute(
      "data-state",
      "active",
    );
  });

  it("says an Artifact is deleted rather than showing an error", () => {
    artifactHook.mockReturnValue({ error: { status: 404 }, isLoading: false });
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

describe("ArtifactViewer while the Agent is still writing", () => {
  beforeEach(() => {
    artifactHook.mockReturnValue({ data: undefined, isLoading: false });
  });

  it("renders the partial content with the title and type once known", () => {
    renderViewer({
      artifactId: undefined,
      live: {
        status: "streaming",
        title: "Release notes",
        type: "markdown",
        content: "# Half a document",
      },
    });

    expect(screen.getByText("Release notes")).toBeInTheDocument();
    expect(screen.getByText("Markdown")).toBeInTheDocument();
    expect(screen.getByText("Streaming")).toBeInTheDocument();
    expect(screen.getByText("# Half a document")).toBeInTheDocument();
  });

  it("waits for content without inventing a title", () => {
    renderViewer({
      artifactId: undefined,
      live: { status: "streaming", content: "" },
    });

    expect(screen.getByText("Creating Artifact…")).toBeInTheDocument();
    expect(
      screen.getByText("Waiting for the Agent to write this Artifact…"),
    ).toBeInTheDocument();
  });

  it("shows partial HTML as source and offers no Preview", () => {
    renderViewer({
      artifactId: undefined,
      live: {
        status: "streaming",
        title: "Chart",
        type: "html",
        content: "<p>Half",
      },
    });

    expect(screen.getByRole("tab", { name: "Preview" })).toBeDisabled();
    expect(screen.getByRole("tab", { name: "Code" })).toHaveAttribute(
      "data-state",
      "active",
    );
    expect(screen.getByText(/```html/)).toBeInTheDocument();
  });

  it("keeps showing the streamed content while the saved version loads", () => {
    artifactHook.mockReturnValue({ data: undefined, isLoading: true });
    renderViewer({
      live: {
        status: "streaming",
        title: "Release notes",
        type: "markdown",
        content: "# Half a document",
      },
    });

    expect(screen.getByText("# Half a document")).toBeInTheDocument();
    expect(screen.queryByText("Loading artifact")).not.toBeInTheDocument();
  });

  it("never presents a failed call's partial content as a saved Artifact", () => {
    renderViewer({
      artifactId: undefined,
      live: {
        status: "failed",
        title: "Release notes",
        type: "markdown",
        content: "# Half a document",
        error: "Artifact content must be at most 512 KB",
      },
    });

    expect(
      screen.getByText("This Artifact was not saved."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Artifact content must be at most 512 KB"),
    ).toBeInTheDocument();
    expect(screen.queryByText("# Half a document")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: "Preview" }),
    ).not.toBeInTheDocument();
  });
});
