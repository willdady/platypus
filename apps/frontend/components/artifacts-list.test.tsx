import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import {
  authMock,
  authState,
  swrMock,
  mockScopedSWR,
  resetListHarness,
  jsonResponse,
  openRowMenu,
  chooseRowMenuAction,
  confirmDialog,
  stubAcceptedSave,
  mutate,
  setupUser,
  toastSuccess,
} from "@/test/list-test-harness";
import { selectOption } from "@/test/test-utils";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("swr", () => swrMock);

import { ArtifactsList } from "./artifacts-list";

function artifact(over: Record<string, unknown> = {}) {
  return {
    id: "a1",
    workspaceId: "ws1",
    sourceChatId: "chat-1",
    title: "Release notes",
    type: "markdown",
    language: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
    ...over,
  };
}

function list(rows: unknown[], totalCount = rows.length) {
  return {
    data: { results: rows, totalCount },
    isLoading: false,
  };
}

function renderArtifacts() {
  return render(<ArtifactsList orgId="org1" workspaceId="ws1" />);
}

beforeEach(() => {
  resetListHarness();
  authState.ownsWorkspace = true;
});

describe("ArtifactsList", () => {
  it("shows each Artifact's title, type and last update, linking to its page", () => {
    mockScopedSWR({ "/artifacts": list([artifact()]) }, { strict: true });
    renderArtifacts();

    expect(screen.getByText("Release notes")).toBeInTheDocument();
    expect(screen.getByText("Markdown")).toBeInTheDocument();
    expect(screen.getByText(/Updated/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Release notes/ })).toHaveAttribute(
      "href",
      "/org1/workspace/ws1/artifacts/a1",
    );
  });

  it("explains how Artifacts get made when there are none", () => {
    mockScopedSWR({ "/artifacts": list([]) }, { strict: true });
    renderArtifacts();

    expect(screen.getByText("No artifacts yet")).toBeInTheDocument();
    expect(screen.getByText(/Artifacts Tool set/)).toBeInTheDocument();
    expect(
      screen.getByRole("searchbox", { name: "Search artifacts" }),
    ).toBeInTheDocument();
  });

  it("offers Upload on an empty page", () => {
    mockScopedSWR({ "/artifacts": list([]) }, { strict: true });
    renderArtifacts();

    expect(screen.getByRole("button", { name: "Upload" })).toBeInTheDocument();
  });

  it("offers Upload beside the rows once there are some", () => {
    mockScopedSWR({ "/artifacts": list([artifact()]) }, { strict: true });
    renderArtifacts();

    expect(screen.getByRole("button", { name: "Upload" })).toBeInTheDocument();
  });

  it("offers no Upload to a member who does not own the workspace", () => {
    authState.ownsWorkspace = false;
    mockScopedSWR({ "/artifacts": list([artifact()]) }, { strict: true });
    renderArtifacts();

    expect(
      screen.queryByRole("button", { name: "Upload" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the toolbar to clear a filter that matched nothing", () => {
    window.history.replaceState(null, "", "?artifactQuery=none");
    mockScopedSWR({ "/artifacts": list([]) }, { strict: true });
    renderArtifacts();

    expect(
      screen.getByText("No artifacts match your filters."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("searchbox", { name: "Search artifacts" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload" })).toBeInTheDocument();
  });

  it("asks the route to search by title", () => {
    mockScopedSWR(
      {
        "search=Release": list([artifact()]),
        "/artifacts": list([artifact()]),
      },
      { strict: true },
    );
    renderArtifacts();

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search artifacts" }),
      {
        target: { value: "Release" },
      },
    );

    expect(window.location.search).toContain("artifactQuery=Release");
    expect(screen.getByText("Release notes")).toBeInTheDocument();
  });

  it("filters by type through the route", async () => {
    mockScopedSWR(
      {
        "type=code": list([
          artifact({
            id: "c1",
            title: "Deploy",
            type: "code",
            language: "bash",
          }),
        ]),
        "/artifacts": list([artifact()]),
      },
      { strict: true },
    );
    renderArtifacts();

    await selectOption("All types", "Code");

    expect(window.location.search).toContain("artifactType=code");
    expect(screen.getByText("Deploy")).toBeInTheDocument();
  });

  it("pages through the route and keeps the page in the URL", async () => {
    mockScopedSWR(
      {
        "offset=20": list([artifact({ id: "a21", title: "Second page" })], 21),
        "/artifacts": list([artifact()], 21),
      },
      { strict: true },
    );
    renderArtifacts();

    await setupUser().click(screen.getByRole("button", { name: "Next page" }));

    expect(window.location.search).toContain("artifactsPage=2");
    expect(screen.getByText("Second page")).toBeInTheDocument();
  });

  it("clamps a page past the end to the last one that exists", async () => {
    window.history.replaceState(null, "", "?artifactsPage=9");
    mockScopedSWR(
      {
        "offset=20": list([artifact({ id: "a21", title: "Second page" })], 21),
        "/artifacts": list([artifact()], 21),
      },
      { strict: true },
    );
    renderArtifacts();

    expect(await screen.findByText("Second page")).toBeInTheDocument();
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
  });

  it("offers no Rename or Delete to a member who does not own the workspace", async () => {
    authState.ownsWorkspace = false;
    mockScopedSWR({ "/artifacts": list([artifact()]) }, { strict: true });
    renderArtifacts();

    await openRowMenu("Release notes");

    expect(
      screen.getByRole("menuitem", { name: "Download" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "Rename" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "Delete" }),
    ).not.toBeInTheDocument();
  });

  it("offers the source Chat only while that Chat still exists", async () => {
    mockScopedSWR(
      { "/artifacts": list([artifact({ sourceChatId: null })]) },
      { strict: true },
    );
    renderArtifacts();

    await openRowMenu("Release notes");

    expect(
      screen.queryByRole("menuitem", { name: "Open source Chat" }),
    ).not.toBeInTheDocument();
  });

  it("opens the source Chat from the menu", async () => {
    mockScopedSWR({ "/artifacts": list([artifact()]) }, { strict: true });
    renderArtifacts();

    await openRowMenu("Release notes");

    expect(
      screen.getByRole("menuitem", { name: "Open source Chat" }),
    ).toHaveAttribute("href", "/org1/workspace/ws1/chat/chat-1");
  });

  it("renames through a dialog that saves the new title", async () => {
    const fetchMock = stubAcceptedSave({ id: "a1", title: "Renamed" });
    mockScopedSWR({ "/artifacts": list([artifact()]) }, { strict: true });
    renderArtifacts();

    await chooseRowMenuAction("Release notes", "Rename");
    const field = screen.getByRole("textbox", { name: "Title" });
    await setupUser().clear(field);
    await setupUser().type(field, "Renamed");
    await setupUser().click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/artifacts/a1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ title: "Renamed" }),
      }),
    );
    expect(toastSuccess).toHaveBeenCalledWith("Artifact renamed");
    expect(mutate).toHaveBeenCalled();
  });

  it("shows a title the backend refused on its field", async () => {
    const fetchMock = stubAcceptedSave(null);
    fetchMock.mockResolvedValue(
      jsonResponse(400, {
        error: [
          {
            path: ["title"],
            message: "Too big: expected string to have <=200 characters",
          },
        ],
      }),
    );
    mockScopedSWR({ "/artifacts": list([artifact()]) }, { strict: true });
    renderArtifacts();

    await chooseRowMenuAction("Release notes", "Rename");
    await setupUser().click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText(
        "Too big: expected string to have <=200 characters",
      ),
    ).toBeInTheDocument();
  });

  it("downloads the latest content in the browser", async () => {
    const createObjectURL = vi.fn(() => "blob:artifact");
    const revokeObjectURL = vi.fn();
    class TestURL extends URL {
      static override createObjectURL = createObjectURL;
      static override revokeObjectURL = revokeObjectURL;
    }
    vi.stubGlobal("URL", TestURL);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    const fetchMock = stubAcceptedSave({
      artifact: artifact(),
      version: {
        id: "v1",
        artifactId: "a1",
        version: 1,
        content: "# Notes",
        author: "agent",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });
    mockScopedSWR({ "/artifacts": list([artifact()]) }, { strict: true });
    renderArtifacts();

    await chooseRowMenuAction("Release notes", "Download");

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/artifacts/a1",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
  });

  it("deletes after confirming and says so", async () => {
    const fetchMock = stubAcceptedSave({});
    mockScopedSWR({ "/artifacts": list([artifact()]) }, { strict: true });
    renderArtifacts();

    await chooseRowMenuAction("Release notes", "Delete");

    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(/deletes all of its versions/i),
    ).toBeInTheDocument();
    await confirmDialog("Delete");

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/artifacts/a1",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(toastSuccess).toHaveBeenCalledWith("Artifact deleted");
    expect(mutate).toHaveBeenCalled();
  });
});
