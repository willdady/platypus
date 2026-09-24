import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { KanbanCard, KanbanCardComment } from "@platypus/schemas";
import { installRadixPointerPolyfills } from "@/lib/test-utils";

beforeAll(() => {
  installRadixPointerPolyfills();
  // The dialog picks a mobile/desktop layout off this; force desktop so only
  // one copy of the comments section renders.
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as unknown as typeof window.matchMedia;
});

// --- Module mocks ------------------------------------------------------------

vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://test",
  useAuth: () => ({ user: { id: "u1", name: "Alice", image: null } }),
}));

const { toastErrorSpy } = vi.hoisted(() => ({ toastErrorSpy: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { error: toastErrorSpy, success: vi.fn() },
}));

// The `GET .../comments` and `.../agents` lists this dialog renders. Set per
// test.
let comments: KanbanCardComment[] = [];
const mutateCommentsSpy = vi.fn();

vi.mock("swr", () => ({
  useSWRConfig: () => ({ cache: new Map() }),
  __esModule: true,
  default: (key: string | null) => {
    if (typeof key === "string" && key.includes("/comments")) {
      return { data: { results: comments }, mutate: mutateCommentsSpy };
    }
    return { data: { results: [] }, mutate: vi.fn() };
  },
}));

import { KanbanCardDialog } from "./kanban-card-dialog";
import { jsonResponse } from "@/lib/test-utils";

// --- Helpers -----------------------------------------------------------------

const card: KanbanCard = {
  id: "c1",
  title: "Ship the release",
  body: "Details",
  labelIds: [],
  assignees: [],
  dueDate: null,
  priority: "none",
  createdAt: new Date("2026-01-01").toISOString(),
  updatedAt: new Date("2026-01-01").toISOString(),
} as unknown as KanbanCard;

const existingComment: KanbanCardComment = {
  id: "cm1",
  body: "First comment",
  createdByName: "Bob",
  createdAt: new Date("2026-01-01").toISOString(),
} as unknown as KanbanCardComment;

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
}

function renderDialog() {
  return render(
    <KanbanCardDialog
      card={card}
      labels={[]}
      columns={[]}
      columnId={null}
      open={true}
      onOpenChange={() => {}}
      onSave={() => {}}
      onDelete={() => {}}
      orgId="org1"
      workspaceId="ws1"
      boardId="b1"
    />,
  );
}

afterEach(() => {
  comments = [];
  mutateCommentsSpy.mockClear();
  toastErrorSpy.mockClear();
  vi.restoreAllMocks();
  setViewportWidth(1024);
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as unknown as typeof window.matchMedia;
});

// --- Tests -------------------------------------------------------------------

describe("KanbanCardDialog add comment", () => {
  it("surfaces the backend's reason and does not revalidate when the comment is refused", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(400, { error: "Comment too long" }));
    vi.stubGlobal("fetch", fetchMock);

    renderDialog();

    fireEvent.change(screen.getByPlaceholderText("Add a comment..."), {
      target: { value: "A new comment" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    await waitFor(() =>
      expect(toastErrorSpy).toHaveBeenCalledWith("Comment too long"),
    );
    expect(mutateCommentsSpy).not.toHaveBeenCalled();
  });
});

describe("KanbanCardDialog edit comment", () => {
  it("surfaces the backend's reason and does not revalidate when the edit is refused", async () => {
    comments = [existingComment];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(404, { error: "Comment not found" }));
    vi.stubGlobal("fetch", fetchMock);

    renderDialog();

    fireEvent.click(screen.getByText("Edit"));
    fireEvent.change(screen.getByDisplayValue("First comment"), {
      target: { value: "Edited comment" },
    });
    // The comment's own Save button renders before the card-level Save
    // button in document order.
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);

    await waitFor(() =>
      expect(toastErrorSpy).toHaveBeenCalledWith("Comment not found"),
    );
    expect(mutateCommentsSpy).not.toHaveBeenCalled();
  });
});

describe("KanbanCardDialog delete comment", () => {
  it("surfaces the backend's reason and does not revalidate when the delete is refused", async () => {
    comments = [existingComment];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(409, { error: "Comment already deleted" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    renderDialog();

    // The comment's own "Delete" link renders before the card-level Delete
    // button in document order.
    fireEvent.click(screen.getAllByText("Delete")[0]);
    // The confirm button inside the just-opened popover is the last "Delete"
    // in the document — the card-level Delete popover trigger is also named
    // "Delete" but stays closed.
    const deleteButtons = screen.getAllByRole("button", { name: "Delete" });
    fireEvent.click(deleteButtons[deleteButtons.length - 1]);

    await waitFor(() =>
      expect(toastErrorSpy).toHaveBeenCalledWith("Comment already deleted"),
    );
    expect(mutateCommentsSpy).not.toHaveBeenCalled();
  });
});

describe("KanbanCardDialog mobile composition", () => {
  it("composes the same sections into tabs instead of the desktop split", () => {
    setViewportWidth(375);
    comments = [existingComment];

    renderDialog();

    // The tabs are the mobile-only container; the details tab composes the
    // same title/body/metadata sections the desktop layout shows.
    expect(screen.getByRole("tab", { name: "Details" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Comments" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "History" })).toBeInTheDocument();
    expect(screen.getByText("Ship the release")).toBeInTheDocument();
    expect(screen.getByText("Priority")).toBeInTheDocument();

    // The comments section is not mounted until its tab is selected.
    expect(
      screen.queryByPlaceholderText("Add a comment..."),
    ).not.toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Comments" }), {
      button: 0,
    });
    expect(screen.getByText("First comment")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Add a comment...")).toBeInTheDocument();
  });
});
