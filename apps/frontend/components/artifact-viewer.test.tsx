import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ComponentProps } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { formatDateTime } from "@/lib/format-date";
import { UnsavedChangesProvider } from "./unsaved-changes-guard";

const { artifactHook, versionsHook, copy, save, auth } = vi.hoisted(() => ({
  artifactHook: vi.fn(),
  versionsHook: vi.fn(),
  copy: vi.fn(async () => true),
  save: vi.fn(),
  auth: { ownsWorkspace: true },
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
vi.mock("@/lib/api-write", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-write")>();
  return {
    ...actual,
    writeAt: (...args: Parameters<typeof save>) => save(...args),
  };
});
vi.mock("@/lib/clipboard", () => ({ copyWithToast: copy }));
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({
    user: { id: "u1" },
    isPending: false,
    ownsWorkspace: auth.ownsWorkspace,
  }),
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
  save.mockReset();
  auth.ownsWorkspace = true;
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
    // No URL on the app or API origin: content travels in `srcdoc` only.
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
    // Hidden below `lg`, where the panel already covers the Chat.
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

describe("ArtifactViewer hand editing a markdown Artifact", () => {
  const savedVersion = {
    id: "v3",
    artifactId: "artifact-1",
    version: 3,
    content: "# Version three",
    author: "user",
    createdAt: "2026-01-03T00:00:00.000Z",
  };

  const savedRead = {
    artifact: markdown.artifact,
    version: savedVersion,
    scriptOrigins: markdown.scriptOrigins,
  };

  const conflictMessage =
    "This Artifact changed while you were editing it. Reload to see the latest version.";

  const editor = () =>
    screen.getByRole("textbox", { name: "Artifact content" });

  const openEditor = () => {
    fireEvent.click(screen.getByRole("button", { name: "Edit Artifact" }));
  };

  const type = (content: string) => {
    fireEvent.change(editor(), { target: { value: content } });
  };

  it("offers Edit on the latest markdown version and previews what is typed", () => {
    renderViewer();

    openEditor();

    expect(editor()).toHaveValue("# Version two");
    // The rendered preview beside the text area follows the text as it changes.
    expect(
      screen.getByText("# Version two", { selector: "pre" }),
    ).toBeInTheDocument();
    type("# Version two, edited");
    expect(
      screen.getByText("# Version two, edited", { selector: "pre" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("edits in full screen and hands the side panel back after", () => {
    const onToggle = vi.fn();
    const { rerender } = renderViewer({
      fullScreen: { active: false, onToggle },
    });

    openEditor();
    expect(onToggle).toHaveBeenCalledOnce();

    rerender(
      <ArtifactViewer
        orgId="org-1"
        workspaceId="ws-1"
        artifactId="artifact-1"
        fullScreen={{ active: true, onToggle }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it("ends the edit when the User exits full screen", () => {
    const onToggle = vi.fn();
    renderViewer({ fullScreen: { active: true, onToggle } });
    openEditor();

    fireEvent.click(screen.getByRole("button", { name: "Exit full screen" }));

    expect(onToggle).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("textbox", { name: "Artifact content" }),
    ).not.toBeInTheDocument();
  });

  it("does not offer Edit on an older version", () => {
    artifactHook.mockImplementation(
      (_scope: unknown, _id: string, version?: number) => ({
        data: version === 1 ? firstVersion : markdown,
        isLoading: false,
      }),
    );
    renderViewer({ version: 1 });

    expect(screen.getByText("Read-only")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Edit Artifact" }),
    ).not.toBeInTheDocument();
  });

  it("does not offer Edit on an Artifact that is not markdown", () => {
    artifactHook.mockReturnValue({
      data: {
        ...markdown,
        artifact: { ...markdown.artifact, type: "code", language: "ts" },
      },
      isLoading: false,
    });
    renderViewer();

    expect(
      screen.queryByRole("button", { name: "Edit Artifact" }),
    ).not.toBeInTheDocument();
  });

  it("does not offer Edit to a member who does not own the Workspace", () => {
    auth.ownsWorkspace = false;
    renderViewer();

    expect(
      screen.queryByRole("button", { name: "Edit Artifact" }),
    ).not.toBeInTheDocument();
  });

  it("does not offer Edit while the Agent is still writing", () => {
    artifactHook.mockReturnValue({ data: undefined, isLoading: false });
    renderViewer({
      artifactId: undefined,
      live: {
        status: "streaming",
        title: "Release notes",
        type: "markdown",
        content: "# Half a document",
      },
    });

    expect(
      screen.queryByRole("button", { name: "Edit Artifact" }),
    ).not.toBeInTheDocument();
  });

  it("saves the edit as a new version based on the one it was edited from", async () => {
    const mutateArtifact = vi.fn();
    const mutateVersions = vi.fn();
    let hasSaved = false;
    artifactHook.mockImplementation(
      (_scope: unknown, _id: string, version?: number) => ({
        data: version === 3 ? savedRead : markdown,
        isLoading: false,
        mutate: mutateArtifact,
      }),
    );
    versionsHook.mockImplementation(() => ({
      data: hasSaved
        ? {
            results: [
              {
                id: "v3",
                artifactId: "artifact-1",
                version: 3,
                author: "user",
                createdAt: "2026-01-03T00:00:00.000Z",
              },
              ...versionList.results,
            ],
          }
        : versionList,
      isLoading: false,
      mutate: mutateVersions,
    }));
    save.mockImplementation(async () => {
      hasSaved = true;
      return { outcome: "success", data: savedRead, revalidateKeys: [] };
    });
    renderViewer();

    openEditor();
    type("# Version three");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(artifactHook).toHaveBeenLastCalledWith(
        { orgId: "org-1", workspaceId: "ws-1" },
        "artifact-1",
        3,
      ),
    );
    expect(save).toHaveBeenCalledWith(
      expect.stringContaining("/artifacts/artifact-1/versions"),
      expect.objectContaining({
        method: "POST",
        data: { content: "# Version three", baseVersion: 2 },
      }),
    );
    expect(mutateVersions).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("Artifact updated");
    // Both reads are revalidated: the viewer shows the new version and the
    // picker lists it as one you wrote.
    expect(await screen.findByText("Version 3")).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Artifact content" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Edit Artifact" }),
    ).toBeInTheDocument();
  });

  it("keeps the text and says the Artifact changed when the base version is stale", async () => {
    save.mockResolvedValue({ outcome: "conflict", message: conflictMessage });
    renderViewer();

    openEditor();
    type("# Version three");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Artifact changed")).toBeInTheDocument();
    expect(screen.getByText(conflictMessage)).toBeInTheDocument();
    expect(editor()).toHaveValue("# Version three");
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("shows a refusal for content over the limit", async () => {
    const message = "Artifact content must be at most 512 KB";
    save.mockResolvedValue({
      outcome: "invalid",
      message,
      fieldErrors: { content: message },
    });
    renderViewer();

    openEditor();
    type("too much");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(editor()).toHaveValue("too much");
    expect(editor()).toHaveAttribute("aria-invalid", "true");
  });

  it("keeps the editor open when a newer version appears while editing", () => {
    let latestVersion = 2;
    const newer = {
      id: "v3",
      artifactId: "artifact-1",
      version: 3,
      author: "agent",
      createdAt: "2026-01-03T00:00:00.000Z",
    };
    versionsHook.mockImplementation(() => ({
      data:
        latestVersion === 3
          ? { results: [newer, ...versionList.results] }
          : versionList,
      isLoading: false,
    }));
    renderViewer();

    openEditor();
    type("# Half typed");

    // The Agent's version lands and the version list revalidates; the edit is
    // still open, still pinned to version 2, and still shows the text.
    latestVersion = 3;
    type("# Half typed, still");

    expect(editor()).toHaveValue("# Half typed, still");
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(screen.getByText("Version 2")).toBeInTheDocument();
    // The version is no longer the latest, but it is being edited, so the open
    // editor is not labelled read-only.
    expect(screen.queryByText("Read-only")).not.toBeInTheDocument();
  });

  it("asks before leaving the edit with unsaved changes", async () => {
    render(
      <UnsavedChangesProvider>
        <ArtifactViewer
          orgId="org-1"
          workspaceId="ws-1"
          artifactId="artifact-1"
        />
      </UnsavedChangesProvider>,
    );

    openEditor();
    type("# Changed");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByText("Discard unsaved changes?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(
      screen.queryByText("Discard unsaved changes?"),
    ).not.toBeInTheDocument();
    // Keeping the edit keeps what was typed.
    expect(editor()).toHaveValue("# Changed");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    expect(
      screen.queryByRole("textbox", { name: "Artifact content" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Edit Artifact" }),
    ).toBeInTheDocument();
  });

  it("leaves the edit without asking when nothing changed", () => {
    renderViewer();

    openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(
      screen.queryByRole("textbox", { name: "Artifact content" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Edit Artifact" }),
    ).toBeInTheDocument();
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
