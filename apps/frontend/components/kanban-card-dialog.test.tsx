import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import type { KanbanCard, KanbanCardComment } from "@platypus/schemas";

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
let comments: Serialized<KanbanCardComment>[] = [];
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
import { UnsavedChangesProvider } from "./unsaved-changes-guard";
import {
  jsonResponse,
  stubAcceptedSave,
  stubPendingSave,
} from "@/test/test-utils";
import type { Serialized, WriteOutcome } from "@/lib/api-write";

// --- Helpers -----------------------------------------------------------------

const card: Serialized<KanbanCard> = {
  id: "c1",
  title: "Ship the release",
  body: "Details",
  labelIds: [],
  assignees: [],
  dueDate: null,
  priority: "none",
  createdAt: new Date("2026-01-01").toISOString(),
  updatedAt: new Date("2026-01-01").toISOString(),
} as unknown as Serialized<KanbanCard>;

const existingComment: Serialized<KanbanCardComment> = {
  id: "cm1",
  body: "First comment",
  createdByName: "Bob",
  createdAt: new Date("2026-01-01").toISOString(),
} as unknown as Serialized<KanbanCardComment>;

// Answers the dialog's `max-width` query for a viewport `width` px wide.
function setViewportWidth(width: number) {
  window.matchMedia = vi.fn((query: string) => {
    const maxWidth = /max-width:\s*(\d+)px/.exec(query);
    return {
      matches: maxWidth ? width <= Number(maxWidth[1]) : false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
  }) as unknown as typeof window.matchMedia;
}

function acceptedDelete(): Promise<WriteOutcome<unknown>> {
  return Promise.resolve({
    outcome: "success",
    data: null,
    revalidateKeys: [],
  });
}

function renderDialog(
  onOpenChange: (open: boolean) => void = () => {},
  onDelete: (cardId: string) => Promise<WriteOutcome<unknown>> = acceptedDelete,
) {
  return render(
    <UnsavedChangesProvider>
      <KanbanCardDialog
        card={card}
        labels={[]}
        columns={[]}
        columnId={null}
        open={true}
        onOpenChange={onOpenChange}
        onSave={() => {}}
        onDelete={onDelete}
        orgId="org1"
        workspaceId="ws1"
        boardId="b1"
      />
    </UnsavedChangesProvider>,
  );
}

/** Opens the card's Delete confirm dialog and returns it. */
async function openCardDeleteConfirm() {
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  return screen.findByRole("dialog", { name: "Delete card" });
}

/** Opens the first comment's Delete confirm dialog and returns it. */
async function openCommentDeleteConfirm() {
  fireEvent.click(
    screen.getByRole("button", { name: /^Delete comment by Bob/ }),
  );
  return screen.findByRole("dialog", { name: "Delete comment" });
}

afterEach(() => {
  comments = [];
  mutateCommentsSpy.mockClear();
  toastErrorSpy.mockClear();
  setViewportWidth(1024);
});

// --- Tests -------------------------------------------------------------------

describe("KanbanCardDialog add comment", () => {
  it("surfaces the backend's reason and does not revalidate when the comment is refused", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(400, { error: "Comment too long" }));
    vi.stubGlobal("fetch", fetchMock);

    renderDialog();

    fireEvent.change(screen.getByRole("textbox", { name: "Add a comment" }), {
      target: { value: "A new comment" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    await waitFor(() =>
      expect(toastErrorSpy).toHaveBeenCalledWith("Comment too long"),
    );
    expect(mutateCommentsSpy).not.toHaveBeenCalled();
  });
});

describe("KanbanCardDialog comment double submit", () => {
  it("sends one comment for a double click, disabled and labelled while pending", async () => {
    const { fetchMock, resolve } = stubPendingSave({ id: "cm2" });
    renderDialog();

    fireEvent.change(screen.getByRole("textbox", { name: "Add a comment" }), {
      target: { value: "A new comment" },
    });
    const submit = screen.getByRole("button", { name: "Comment" });
    fireEvent.click(submit);
    fireEvent.click(submit);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(submit).toBeDisabled();
    expect(submit).toHaveTextContent("Commenting...");
    resolve();
    await waitFor(() => expect(mutateCommentsSpy).toHaveBeenCalledOnce());
  });

  it("sends one comment delete for a double click", async () => {
    comments = [existingComment];
    const { fetchMock, resolve } = stubPendingSave();
    renderDialog();
    const cardDelete = screen.getByRole("button", { name: "Delete" });

    const confirmDialog = await openCommentDeleteConfirm();
    const confirm = within(confirmDialog).getByRole("button", {
      name: "Delete",
    });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveTextContent("Deleting...");
    // The card's own Delete waits on its own guard, not this one.
    expect(cardDelete).not.toHaveTextContent("Deleting...");
    resolve();
    await waitFor(() => expect(mutateCommentsSpy).toHaveBeenCalledOnce());
  });

  it("labels only the comment write in flight as pending", async () => {
    comments = [existingComment];
    const { resolve } = stubPendingSave({ id: "cm2" });
    renderDialog();

    fireEvent.change(screen.getByRole("textbox", { name: "Add a comment" }), {
      target: { value: "A new comment" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    expect(
      await screen.findByRole("button", { name: "Commenting..." }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /^Delete comment by Bob/ }),
    ).toHaveTextContent(/^Delete$/);
    resolve();
  });

  it("sends one comment edit for a double click", async () => {
    comments = [existingComment];
    const { fetchMock, resolve } = stubPendingSave({ id: "cm1" });
    renderDialog();

    fireEvent.click(screen.getByText("Edit"));
    const save = screen.getAllByRole("button", { name: "Save" })[0];
    fireEvent.click(save);
    fireEvent.click(save);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    resolve();
    await waitFor(() => expect(mutateCommentsSpy).toHaveBeenCalledOnce());
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

describe("KanbanCardDialog editing", () => {
  it("labels the title and description fields visibly", () => {
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Edit card" }));

    const title = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Title",
    });
    expect(title).toHaveValue("Ship the release");
    expect(title.labels?.[0]).toHaveTextContent("Title");
    const description = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Description",
    });
    expect(description).toHaveValue("Details");
    expect(description.labels?.[0]).toHaveTextContent("Description");
  });
});

describe("KanbanCardDialog comment actions", () => {
  it("names each comment's Edit and Delete after the comment they act on", () => {
    comments = [
      existingComment,
      { ...existingComment, id: "cm2", createdByName: "Carol" },
    ];
    renderDialog();

    expect(
      screen.getByRole("button", { name: /^Edit comment by Bob/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Edit comment by Carol/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Delete comment by Carol/ }),
    ).toBeInTheDocument();
  });
});

describe("KanbanCardDialog delete comment", () => {
  it("shows the backend's reason inline, keeps the dialog open, and does not revalidate when refused", async () => {
    comments = [existingComment];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(409, { error: "Comment already deleted" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    renderDialog();
    const confirmDialog = await openCommentDeleteConfirm();
    fireEvent.click(
      within(confirmDialog).getByRole("button", { name: "Delete" }),
    );

    expect(
      await within(confirmDialog).findByText("Comment already deleted"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("dialog", { name: "Delete comment" }),
    ).toBeInTheDocument();
    expect(toastErrorSpy).not.toHaveBeenCalled();
    expect(mutateCommentsSpy).not.toHaveBeenCalled();
    // The comment stays in the thread to retry against.
    expect(screen.getByText("First comment")).toBeInTheDocument();
  });

  it("returns focus to the comment's Delete button when cancelled", async () => {
    comments = [existingComment];
    renderDialog();

    const confirmDialog = await openCommentDeleteConfirm();
    fireEvent.click(
      within(confirmDialog).getByRole("button", { name: "Cancel" }),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Delete comment" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: /^Delete comment by Bob/ }),
    ).toHaveFocus();
  });

  it("removes the comment and closes the confirm dialog on success", async () => {
    comments = [existingComment];
    stubAcceptedSave();
    renderDialog();

    const confirmDialog = await openCommentDeleteConfirm();
    fireEvent.click(
      within(confirmDialog).getByRole("button", { name: "Delete" }),
    );

    await waitFor(() => expect(mutateCommentsSpy).toHaveBeenCalledOnce());
    expect(
      screen.queryByRole("dialog", { name: "Delete comment" }),
    ).not.toBeInTheDocument();
    expect(toastErrorSpy).not.toHaveBeenCalled();
  });
});

describe("KanbanCardDialog delete card", () => {
  it("shows a refusal inline, keeps both dialogs open, and does not toast", async () => {
    const onDelete = vi.fn().mockResolvedValue({
      outcome: "forbidden",
      message: "Only the owner can delete this card",
    });
    renderDialog(() => {}, onDelete);

    const confirmDialog = await openCardDeleteConfirm();
    fireEvent.click(
      within(confirmDialog).getByRole("button", { name: "Delete" }),
    );

    expect(
      await within(confirmDialog).findByText(
        "Only the owner can delete this card",
      ),
    ).toBeInTheDocument();
    expect(onDelete).toHaveBeenCalledWith("c1");
    expect(toastErrorSpy).not.toHaveBeenCalled();
    // The card dialog is still there, so the delete can be retried.
    expect(screen.getByText("Ship the release")).toBeInTheDocument();
    expect(
      screen.getByRole("dialog", { name: "Delete card" }),
    ).toBeInTheDocument();
  });

  it("closes the confirm dialog on success", async () => {
    const onDelete = vi.fn(acceptedDelete);
    renderDialog(() => {}, onDelete);

    const confirmDialog = await openCardDeleteConfirm();
    fireEvent.click(
      within(confirmDialog).getByRole("button", { name: "Delete" }),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Delete card" }),
      ).not.toBeInTheDocument(),
    );
    expect(onDelete).toHaveBeenCalledWith("c1");
    expect(toastErrorSpy).not.toHaveBeenCalled();
  });

  it("cancels back to the card dialog without tripping the unsaved-changes guard", async () => {
    const onOpenChange = vi.fn();
    renderDialog(onOpenChange);
    fireEvent.click(screen.getByRole("button", { name: "Edit card" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
      target: { value: "Renamed" },
    });

    const confirmDialog = await openCardDeleteConfirm();
    fireEvent.click(
      within(confirmDialog).getByRole("button", { name: "Cancel" }),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Delete card" }),
      ).not.toBeInTheDocument(),
    );
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(
      screen.queryByText("Discard unsaved changes?"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Renamed")).toBeInTheDocument();
    // Focus goes back to the button that opened the confirm.
    expect(screen.getByRole("button", { name: "Delete" })).toHaveFocus();
  });
});

describe("KanbanCardDialog details scroll area", () => {
  // jsdom has no layout, so pin the class instead of measuring overlap (#1591).
  it("stops its children shrinking", () => {
    renderDialog();

    expect(screen.getByTestId("card-details-scroll")).toHaveClass(
      "[&>*]:shrink-0",
    );
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
      screen.queryByRole("textbox", { name: "Add a comment" }),
    ).not.toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Comments" }), {
      button: 0,
    });
    expect(screen.getByText("First comment")).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Add a comment" }),
    ).toBeInTheDocument();
  });
});

describe("KanbanCardDialog close with unsaved changes", () => {
  const close = () =>
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);

  it("closes at once with nothing changed", () => {
    const onOpenChange = vi.fn();
    renderDialog(onOpenChange);

    close();

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(
      screen.queryByText("Discard unsaved changes?"),
    ).not.toBeInTheDocument();
  });

  it("prompts for a changed field, staying open on Keep editing", () => {
    const onOpenChange = vi.fn();
    renderDialog(onOpenChange);
    fireEvent.click(screen.getByRole("button", { name: "Edit card" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
      target: { value: "Renamed" },
    });

    close();
    expect(screen.getByText("Discard unsaved changes?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));

    expect(onOpenChange).not.toHaveBeenCalled();
    // Leaving the editor shows the title as text, still the edited value.
    expect(screen.getByText("Renamed")).toBeInTheDocument();
  });

  it("does not prompt once a changed field is reverted", () => {
    const onOpenChange = vi.fn();
    renderDialog(onOpenChange);
    fireEvent.click(screen.getByRole("button", { name: "Edit card" }));
    const title = screen.getByRole("textbox", { name: "Title" });
    fireEvent.change(title, { target: { value: "Renamed" } });
    fireEvent.change(title, { target: { value: "Ship the release" } });

    close();

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("prompts for an unsent comment draft and closes on Discard", () => {
    const onOpenChange = vi.fn();
    renderDialog(onOpenChange);
    fireEvent.change(screen.getByRole("textbox", { name: "Add a comment" }), {
      target: { value: "Draft" },
    });

    close();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("prompts for a comment mid-edit", () => {
    comments = [existingComment];
    const onOpenChange = vi.fn();
    renderDialog(onOpenChange);
    fireEvent.click(
      screen.getByRole("button", { name: /^Edit comment by Bob/ }),
    );

    close();

    expect(screen.getByText("Discard unsaved changes?")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
