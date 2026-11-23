import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { PlatypusUIMessage } from "@platypus/schemas";
import { authMock } from "@/test/test-utils";

const { reads, download } = vi.hoisted(() => ({
  reads: new Map<string, { data?: unknown; deleted?: boolean }>(),
  download: vi.fn(),
}));

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("next/navigation", () => ({
  useParams: () => ({ orgId: "org1", workspaceId: "ws1" }),
}));
vi.mock("@/hooks/use-artifact", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-artifact")>();
  return {
    ...actual,
    useStoredArtifact: (stored?: { id: string; version: number }) =>
      reads.get(`${stored?.id}:${stored?.version}`) ?? {},
  };
});
vi.mock("@/lib/artifact-download", () => ({
  downloadArtifactContent: download,
}));

import { ARTIFACT_DELETED_DETAIL, replyArtifacts } from "./artifact-tool-card";
import { OfferedFiles, offeredFiles } from "./offered-files";

type MessagePart = NonNullable<PlatypusUIMessage["parts"]>[number];

function offer(
  path: string,
  size: number,
  state = "output-available",
): MessagePart {
  return {
    type: "tool-fsDownload",
    toolCallId: `call-${path}-${size}`,
    state,
    input: { path },
    output: state === "output-available" ? { path, size } : undefined,
    errorText: state === "output-error" ? "not found" : undefined,
  } as unknown as MessagePart;
}

/** A stored write to `artifactId`, at `version`. */
function write(
  artifactId: string,
  version: number,
  over: Record<string, unknown> = {},
): MessagePart {
  return {
    type: "tool-createArtifact",
    toolCallId: `call-${artifactId}-${version}`,
    state: "output-available",
    input: { title: "Release notes", type: "markdown", content: "# 1" },
    output: { id: artifactId, title: "Release notes", version },
    ...over,
  } as unknown as MessagePart;
}

/** What a row's read lands on: one Artifact at one version. */
function read(version: number, content = "# 1.1") {
  return {
    data: {
      artifact: {
        id: "artifact-1",
        title: "Release notes",
        type: "markdown",
        language: null,
      },
      version: { version, content },
    },
  };
}

beforeEach(() => {
  reads.clear();
});

describe("offeredFiles", () => {
  it("keeps one entry per path, with the latest offer's size", () => {
    expect(
      offeredFiles([
        offer("out/a.csv", 1),
        { type: "step-start" },
        offer("b.pdf", 5),
        offer("out/a.csv", 2),
        offer("out/a.csv", 3),
      ]),
    ).toEqual([
      { path: "out/a.csv", size: 3 },
      { path: "b.pdf", size: 5 },
    ]);
  });

  it("leaves out failed and unfinished calls", () => {
    expect(
      offeredFiles([
        offer("gone.txt", 0, "output-error"),
        offer("pending.txt", 0, "input-available"),
      ]),
    ).toEqual([]);
  });
});

describe("replyArtifacts", () => {
  it("keeps one entry per Artifact, at the latest version the message wrote", () => {
    expect(
      replyArtifacts([
        write("a", 1),
        { type: "step-start" },
        write("a", 2, { type: "tool-updateArtifact" }),
        write("b", 1),
      ]),
    ).toEqual([
      { id: "a", title: "Release notes", version: 2 },
      { id: "b", title: "Release notes", version: 1 },
    ]);
  });

  it("keeps the highest version, not the last write listed", () => {
    expect(replyArtifacts([write("a", 3), write("a", 2)])).toEqual([
      { id: "a", title: "Release notes", version: 3 },
    ]);
  });

  it("leaves out failed and unfinished writes", () => {
    expect(
      replyArtifacts([
        write("a", 1, {
          state: "output-error",
          output: undefined,
          errorText: "too big",
        }),
        write("a", 1, { state: "input-streaming", output: undefined }),
        write("a", 1, { output: { error: "Edit 1 matched 0 times" } }),
        write("a", 1, {
          state: "output-denied",
          output: undefined,
          approval: { id: "ap1", approved: false, reason: "Blocked" },
        }),
      ]),
    ).toEqual([]);
  });
});

describe("OfferedFiles", () => {
  it("shows each file's name, path and size, with a Download link to the Workspace's download route", () => {
    render(
      <OfferedFiles
        files={[{ path: "out/report 1.pdf", size: 1234 }]}
        artifacts={[]}
      />,
    );

    expect(screen.getByText("report 1.pdf")).toBeInTheDocument();
    expect(screen.getByText("out/report 1.pdf")).toBeInTheDocument();
    expect(screen.getByText("1.2 KB")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /download/i })).toHaveAttribute(
      "href",
      "http://test/organizations/org1/workspaces/ws1/sandbox/file?path=out%2Freport+1.pdf",
    );
  });

  it("shows a stored Artifact's title, type and version, and opens that version", () => {
    reads.set("artifact-1:2", read(2));
    const onOpen = vi.fn();
    render(
      <OfferedFiles
        files={[]}
        artifacts={[{ id: "artifact-1", title: "Release notes", version: 2 }]}
        scope={{ orgId: "org1", workspaceId: "ws1" }}
        onOpen={onOpen}
      />,
    );

    expect(screen.getByText("Release notes")).toBeInTheDocument();
    expect(screen.getByText("Markdown · Version 2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /open/i }));

    expect(onOpen).toHaveBeenCalledWith({ id: "artifact-1", version: 2 });
  });

  it("downloads the version's content through the viewer's own helper", () => {
    reads.set("artifact-1:2", read(2, "# 1.1"));
    render(
      <OfferedFiles
        files={[]}
        artifacts={[{ id: "artifact-1", title: "Release notes", version: 2 }]}
        scope={{ orgId: "org1", workspaceId: "ws1" }}
        onOpen={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /download/i }));

    expect(download).toHaveBeenCalledWith(
      {
        id: "artifact-1",
        title: "Release notes",
        type: "markdown",
        language: null,
      },
      "# 1.1",
    );
  });

  it("says a deleted Artifact is gone, offering neither Open nor Download", () => {
    reads.set("artifact-1:1", { deleted: true });
    render(
      <OfferedFiles
        files={[]}
        artifacts={[{ id: "artifact-1", title: "Release notes", version: 1 }]}
        scope={{ orgId: "org1", workspaceId: "ws1" }}
        onOpen={vi.fn()}
      />,
    );

    // The title is kept, so several deleted rows stay apart.
    expect(screen.getByText("Release notes")).toBeInTheDocument();
    expect(screen.getByText(ARTIFACT_DELETED_DETAIL)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("offers Open before the read lands, and Download only once it has the content", () => {
    render(
      <OfferedFiles
        files={[]}
        artifacts={[{ id: "artifact-1", title: "Release notes", version: 2 }]}
        scope={{ orgId: "org1", workspaceId: "ws1" }}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /open/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /download/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps an offered file row beside an Artifact row in the one tray", () => {
    reads.set("artifact-1:1", read(1));
    render(
      <OfferedFiles
        files={[{ path: "out/report.pdf", size: 10 }]}
        artifacts={[{ id: "artifact-1", title: "Release notes", version: 1 }]}
        scope={{ orgId: "org1", workspaceId: "ws1" }}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
    expect(screen.getByText("Release notes")).toBeInTheDocument();
  });
});
