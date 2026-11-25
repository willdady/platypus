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
  ArtifactMarkdown: ({
    content,
    storageBaseUrl,
  }: {
    content: string;
    storageBaseUrl?: string | null;
  }) => <pre data-storage-base={storageBaseUrl ?? ""}>{content}</pre>,
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
  scriptOrigins: ["https://cdnjs.cloudflare.com"],
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

  it("passes the deployment's storage base from the read into the document", () => {
    artifactHook.mockReturnValue({
      data: { ...markdown, storageBaseUrl: "https://cdn.example.com" },
      isLoading: false,
    });
    renderViewer();

    expect(screen.getByText("# Version two")).toHaveAttribute(
      "data-storage-base",
      "https://cdn.example.com",
    );
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

  it("runs an HTML Artifact in a frame fed by srcDoc, with exactly allow-scripts", () => {
    artifactHook.mockReturnValue({
      data: {
        ...markdown,
        artifact: { ...markdown.artifact, type: "html" },
        version: { ...markdown.version, content: "<h1>Quarterly sales</h1>" },
      },
      isLoading: false,
    });
    renderViewer();

    const frame = screen.getByTitle("Artifact preview");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame).not.toHaveAttribute("src");
    const doc = frame.getAttribute("srcdoc") ?? "";
    expect(doc).toContain("<h1>Quarterly sales</h1>");
    expect(doc).not.toContain("/files/");
    expect(screen.getByRole("tab", { name: "Preview" })).toHaveAttribute(
      "data-state",
      "active",
    );
  });

  it("keeps the Code tab available beside an HTML Artifact's preview", () => {
    artifactHook.mockReturnValue({
      data: {
        ...markdown,
        artifact: { ...markdown.artifact, type: "html" },
        version: { ...markdown.version, content: "<p>Hi</p>" },
      },
      isLoading: false,
    });
    renderViewer();

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Code" }), {
      button: 0,
    });

    expect(screen.getByText(/```html/)).toBeInTheDocument();
  });

  it("lets an approved library origin into the frame's policy", () => {
    artifactHook.mockReturnValue({
      data: {
        ...markdown,
        artifact: { ...markdown.artifact, type: "html" },
        version: {
          ...markdown.version,
          content:
            '<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>',
        },
      },
      isLoading: false,
    });
    renderViewer();

    const doc = screen.getByTitle("Artifact preview").getAttribute("srcdoc");
    expect(doc).toContain(
      "script-src 'unsafe-inline' https://cdnjs.cloudflare.com",
    );
  });

  it("shows a notice naming the site when its own frame reports a block", () => {
    artifactHook.mockReturnValue({
      data: {
        ...markdown,
        artifact: { ...markdown.artifact, type: "html" },
        version: { ...markdown.version, content: "<p>Hi</p>" },
        scriptOrigins: [],
      },
      isLoading: false,
    });
    renderViewer();
    const frame = screen.getByTitle("Artifact preview") as HTMLIFrameElement;

    fireEvent(
      window,
      new MessageEvent("message", {
        data: {
          type: "artifact-frame-blocked",
          origin: "https://cdnjs.cloudflare.com",
        },
        source: frame.contentWindow,
      }),
    );

    expect(screen.getByText(/Blocked content/)).toBeInTheDocument();
    expect(
      screen.getByText(/https:\/\/cdnjs\.cloudflare\.com/),
    ).toBeInTheDocument();
  });

  it("ignores a block report that does not come from its own frame", () => {
    artifactHook.mockReturnValue({
      data: {
        ...markdown,
        artifact: { ...markdown.artifact, type: "html" },
        version: { ...markdown.version, content: "<p>Hi</p>" },
        scriptOrigins: [],
      },
      isLoading: false,
    });
    renderViewer();

    fireEvent(
      window,
      new MessageEvent("message", {
        data: {
          type: "artifact-frame-blocked",
          origin: "https://cdnjs.cloudflare.com",
        },
        source: window,
      }),
    );

    expect(screen.queryByText(/Blocked content/)).not.toBeInTheDocument();
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

  it("previews an older HTML version in the frame when the picker changes it", async () => {
    artifactHook.mockImplementation(
      (_scope: unknown, _id: string, version?: number) => ({
        data: {
          ...markdown,
          artifact: { ...markdown.artifact, type: "html" },
          version:
            version === 1
              ? {
                  ...markdown.version,
                  id: "v1",
                  version: 1,
                  content: "<h1>Old page</h1>",
                }
              : { ...markdown.version, content: "<h1>New page</h1>" },
          scriptOrigins: [],
        },
        isLoading: false,
      }),
    );
    renderViewer();

    const frame = screen.getByTitle("Artifact preview") as HTMLIFrameElement;
    expect(frame.srcdoc).toContain("<h1>New page</h1>");

    await selectOption(
      "Version 2",
      `Version 1 · You · ${formatDateTime("2026-01-01T00:00:00.000Z")}`,
    );

    const doc = (screen.getByTitle("Artifact preview") as HTMLIFrameElement)
      .srcdoc;
    expect(doc).toContain("<h1>Old page</h1>");
    expect(doc).not.toContain("New page");
    expect(screen.getByText("Read-only")).toBeInTheDocument();
  });

  it("closes from the header", () => {
    const onClose = vi.fn();
    renderViewer({ onClose });

    fireEvent.click(screen.getByRole("button", { name: "Close Artifact" }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("offers the full-screen toggle only where the panel passes one", () => {
    const onToggle = vi.fn();
    const { unmount } = renderViewer({
      fullScreen: { active: false, onToggle },
    });

    const expand = screen.getByRole("button", { name: "View full screen" });
    expect(expand).toHaveClass("hidden", "lg:inline-flex");
    fireEvent.click(expand);
    expect(onToggle).toHaveBeenCalledOnce();
    unmount();

    const expanded = renderViewer({ fullScreen: { active: true, onToggle } });
    expect(
      screen.getByRole("button", { name: "Exit full screen" }),
    ).toBeInTheDocument();
    expanded.unmount();

    renderViewer();
    expect(
      screen.queryByRole("button", { name: /full screen/ }),
    ).not.toBeInTheDocument();
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

  it("renders no frame for a streaming HTML Artifact", () => {
    renderViewer({
      artifactId: undefined,
      live: {
        status: "streaming",
        title: "Chart",
        type: "html",
        content: "<p>Half a page",
      },
    });

    expect(screen.queryByTitle("Artifact preview")).not.toBeInTheDocument();
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
