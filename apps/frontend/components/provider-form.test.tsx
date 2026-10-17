import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import type { Provider } from "@platypus/schemas";
import {
  authMock,
  swrMock,
  setData,
  setDataFor,
  setError,
  resetFormHarness,
  stubAcceptedSave,
  stubRejectedSave,
  savedBody,
} from "@/test/form-test-harness";
import { selectOption } from "@/test/test-utils";

// --- Module mocks ------------------------------------------------------------

vi.mock("@/components/auth-provider", () => authMock);
// The form makes two reads: the Provider being edited, and the
// `GET /organizations/:orgId/web-backends` catalog. The harness keys its
// responses off the request URL suffix so the catalog read does not get
// handed the Provider, which carries no `results`.
vi.mock("swr", () => swrMock);

import { ProviderForm } from "./provider-form";
import { UnsavedChangesProvider } from "./unsaved-changes-guard";

// --- Helpers -----------------------------------------------------------------

/** The body an accepted save resolves with, so the form can read it back. */
const ACCEPTED_SAVE = { id: "p1", aliasRepoints: [] };

function renderEditForm(modelIds: Provider["modelIds"]) {
  setData({
    id: "p1",
    name: "OpenAI",
    providerType: "OpenAI",
    apiKey: "sk-test",
    apiMode: "responses",
    modelIds,
    taskModelId: "gpt-4o",
    memoryExtractionModelId: "gpt-4o",
  } as unknown as Provider);
  return render(<ProviderForm orgId="org1" providerId="p1" />, {
    wrapper: UnsavedChangesProvider,
  });
}

/** Whether leaving the page now would prompt, i.e. the form is dirty. */
function unload() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

/** The card for the model whose title reads `id`. */
function modelCard(id: string) {
  const card = screen
    // Hidden too: an open dialog hides the form from the accessibility tree.
    .getAllByRole("listitem", { hidden: true })
    .find((li) => within(li).queryByText(id, { selector: "p" }));
  if (!card) throw new Error(`No card for model "${id}"`);
  return card;
}

function openAddDialog() {
  fireEvent.click(screen.getByRole("button", { name: "Add model" }));
  return screen.getByRole("dialog", { name: "Add model" });
}

function openEditDialog(id: string) {
  fireEvent.click(screen.getByRole("button", { name: `Edit model ${id}` }));
  return screen.getByRole("dialog", { name: "Edit model" });
}

function type(dialog: HTMLElement, label: string, value: string) {
  fireEvent.change(within(dialog).getByLabelText(label), {
    target: { value },
  });
}

/** The `modelIds` the form put on the wire for the last save. */
function savedModelIds(fetchMock: ReturnType<typeof vi.fn>) {
  return savedBody(fetchMock).modelIds as ({ id: string } & Record<
    string,
    unknown
  >)[];
}

function save() {
  return fireEvent.click(screen.getByRole("button", { name: "Update" }));
}

beforeEach(() => {
  resetFormHarness();
  // Empty by default — the Web search selector offers only None (and the
  // built-in search option, where the Provider has one) for every test that
  // predates the catalog.
  setDataFor("/web-backends", { results: [] });
});

// --- Tests -------------------------------------------------------------------

describe("ProviderForm model cards", () => {
  it("shows each model as a card, with no inputs outside a dialog", () => {
    renderEditForm([
      { id: "gpt-4o", passthroughFileTypes: [] },
      { id: "o3", passthroughFileTypes: [] },
    ]);

    expect(modelCard("gpt-4o")).toBeInTheDocument();
    expect(modelCard("o3")).toBeInTheDocument();
    expect(screen.queryByLabelText("Model ID")).not.toBeInTheDocument();
  });

  it("shows the alias as a badge and only the fields that are set", () => {
    renderEditForm([
      {
        id: "gpt-4o",
        alias: "flagship",
        passthroughFileTypes: ["image/*", "application/pdf"],
        contextWindow: 128000,
        maxOutputTokens: 64000,
      },
      { id: "o3", passthroughFileTypes: [] },
    ]);

    const full = modelCard("gpt-4o");
    expect(within(full).getByText("flagship")).toBeInTheDocument();
    expect(full).toHaveTextContent("Context window: 128k");
    expect(full).toHaveTextContent(
      "Native file types: image/*, application/pdf",
    );
    expect(full).toHaveTextContent("Max output tokens: 64,000");
    expect(full).not.toHaveTextContent("Max extracted text characters");

    const bare = modelCard("o3");
    expect(bare).not.toHaveTextContent("Context window");
    expect(bare).not.toHaveTextContent("Native file types");
    expect(bare).not.toHaveTextContent("Max output tokens");
  });

  it("shows an unlisted Context window as its token count", () => {
    renderEditForm([
      { id: "qwen", passthroughFileTypes: [], contextWindow: 131072 },
    ]);

    expect(modelCard("qwen")).toHaveTextContent("Context window: 131,072");
  });

  it("leaves a legacy string model loadable as a card", () => {
    renderEditForm(["gpt-4o"] as unknown as Provider["modelIds"]);

    expect(modelCard("gpt-4o")).toBeInTheDocument();
  });

  it("shows No models yet. for an empty list", () => {
    renderEditForm([]);

    expect(screen.getByText("No models yet.")).toBeInTheDocument();
  });

  it("removes a card straight away, with no confirm dialog", async () => {
    const fetchMock = stubAcceptedSave(ACCEPTED_SAVE);
    renderEditForm([
      { id: "gpt-4o", passthroughFileTypes: [] },
      { id: "o3", passthroughFileTypes: [] },
    ]);

    fireEvent.click(
      screen.getByRole("button", { name: "Remove model gpt-4o" }),
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("gpt-4o")).not.toBeInTheDocument();
    save();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedModelIds(fetchMock)).toEqual([
      { id: "o3", passthroughFileTypes: [] },
    ]);
  });

  it("sends a declared window back unchanged, so it survives a save", async () => {
    const fetchMock = stubAcceptedSave(ACCEPTED_SAVE);

    renderEditForm([
      { id: "gpt-4o", passthroughFileTypes: [], contextWindow: 200000 },
    ]);
    save();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedModelIds(fetchMock)).toEqual([
      { id: "gpt-4o", passthroughFileTypes: [], contextWindow: 200000 },
    ]);
  });

  // A Workspace viewing an Organization provider: the card already shows every
  // set field, so there is nothing a dialog would add.
  it("offers no Edit, Remove or Add model on a read-only provider", () => {
    setData({
      id: "p1",
      name: "Shared",
      providerType: "OpenAI",
      apiMode: "responses",
      scope: "organization",
      modelIds: [{ id: "gpt-4o", passthroughFileTypes: [] }],
      taskModelId: "gpt-4o",
      memoryExtractionModelId: "gpt-4o",
    } as unknown as Provider);
    render(<ProviderForm orgId="org1" workspaceId="ws1" providerId="p1" />);

    expect(modelCard("gpt-4o")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Edit model gpt-4o" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove model gpt-4o" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add model" }),
    ).not.toBeInTheDocument();
  });
});

describe("ProviderForm model dialog", () => {
  it("opens Add model with all six fields and appends the card on Add", async () => {
    const fetchMock = stubAcceptedSave(ACCEPTED_SAVE);
    renderEditForm([{ id: "gpt-4o", passthroughFileTypes: [] }]);
    expect(unload()).toBe(false);

    const dialog = openAddDialog();
    for (const label of [
      "Model ID",
      "Alias",
      "Context window",
      "Native file types",
      "Max extracted text characters",
      "Max output tokens",
    ]) {
      expect(within(dialog).getByLabelText(label)).toBeInTheDocument();
      expect(
        within(dialog).getByRole("button", { name: `About ${label}` }),
      ).toBeInTheDocument();
    }
    expect(
      within(dialog).queryByRole("button", { name: "Advanced" }),
    ).not.toBeInTheDocument();

    type(dialog, "Model ID", "o3");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(modelCard("o3")).toBeInTheDocument();
    expect(unload()).toBe(true);
    save();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedModelIds(fetchMock)).toEqual([
      { id: "gpt-4o", passthroughFileTypes: [] },
      { id: "o3", passthroughFileTypes: [] },
    ]);
  });

  it("opens Edit model pre-filled and updates the card in place on Save", async () => {
    const fetchMock = stubAcceptedSave(ACCEPTED_SAVE);
    renderEditForm([
      {
        id: "gpt-4o",
        alias: "flagship",
        passthroughFileTypes: ["image/*"],
        maxExtractedTextChars: 1000,
        maxOutputTokens: 64000,
        contextWindow: 131072,
      },
      { id: "o3", passthroughFileTypes: [] },
    ]);

    const dialog = openEditDialog("gpt-4o");
    expect(within(dialog).getByLabelText("Model ID")).toHaveValue("gpt-4o");
    expect(within(dialog).getByLabelText("Alias")).toHaveValue("flagship");
    expect(within(dialog).getByLabelText("Context window")).toHaveTextContent(
      "Custom",
    );
    expect(
      within(dialog).getByLabelText("Context window in tokens"),
    ).toHaveValue(131072);
    expect(within(dialog).getByLabelText("Native file types")).toHaveValue(
      "image/*",
    );
    expect(
      within(dialog).getByLabelText("Max extracted text characters"),
    ).toHaveValue(1000);
    expect(within(dialog).getByLabelText("Max output tokens")).toHaveValue(
      64000,
    );

    type(dialog, "Model ID", "gpt-5");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    save();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedModelIds(fetchMock).map((m: { id: string }) => m.id)).toEqual([
      "gpt-5",
      "o3",
    ]);
  });

  // The dialog is portalled out of the DOM tree but not the React tree, so its
  // submit would otherwise bubble to a form the provider form sits in.
  it("saves the model on Enter without submitting an enclosing form", () => {
    const outerSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    setData({
      id: "p1",
      name: "OpenAI",
      providerType: "OpenAI",
      apiKey: "sk-test",
      apiMode: "responses",
      modelIds: [{ id: "gpt-4o", passthroughFileTypes: [] }],
      taskModelId: "gpt-4o",
      memoryExtractionModelId: "gpt-4o",
    } as unknown as Provider);
    render(
      <form onSubmit={outerSubmit}>
        <ProviderForm orgId="org1" providerId="p1" />
      </form>,
    );

    const dialog = openEditDialog("gpt-4o");
    type(dialog, "Model ID", "gpt-5");
    fireEvent.submit(within(dialog).getByLabelText("Model ID"));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(modelCard("gpt-5")).toBeInTheDocument();
    expect(outerSubmit).not.toHaveBeenCalled();
  });

  it("focuses Model ID when the dialog opens", () => {
    renderEditForm([]);

    const dialog = openAddDialog();

    expect(within(dialog).getByLabelText("Model ID")).toHaveFocus();
  });

  it("leaves the form clean after Save with nothing changed", () => {
    renderEditForm([
      { id: "gpt-4o", alias: "flagship", passthroughFileTypes: ["image/*"] },
      "o3",
    ] as unknown as Provider["modelIds"]);

    for (const id of ["gpt-4o", "o3"]) {
      const dialog = openEditDialog(id);
      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    }

    expect(unload()).toBe(false);
  });

  it("makes the form dirty on Remove", () => {
    renderEditForm([{ id: "gpt-4o", passthroughFileTypes: [] }]);

    fireEvent.click(
      screen.getByRole("button", { name: "Remove model gpt-4o" }),
    );

    expect(unload()).toBe(true);
  });

  it("shows a stored listed size on the closed control", () => {
    renderEditForm([
      { id: "gpt-4o", passthroughFileTypes: [], contextWindow: 128000 },
    ]);

    const dialog = openEditDialog("gpt-4o");
    expect(within(dialog).getByLabelText("Context window")).toHaveTextContent(
      "128k",
    );
    expect(
      within(dialog).queryByLabelText("Context window in tokens"),
    ).not.toBeInTheDocument();
  });

  it.each([
    [
      "Cancel",
      (dialog: HTMLElement) =>
        fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" })),
    ],
    [
      "Esc",
      () => fireEvent.keyDown(document.activeElement!, { key: "Escape" }),
    ],
  ])("discards the dialog's edits on %s, with no prompt", (_, close) => {
    renderEditForm([{ id: "gpt-4o", passthroughFileTypes: [] }]);

    const dialog = openEditDialog("gpt-4o");
    type(dialog, "Model ID", "changed");
    close(dialog);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Discard unsaved changes?"),
    ).not.toBeInTheDocument();
    expect(modelCard("gpt-4o")).toBeInTheDocument();
    expect(unload()).toBe(false);
  });

  it("blocks Add on an empty Model ID and stages nothing", () => {
    renderEditForm([]);

    const dialog = openAddDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Model ID")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(screen.getByText("No models yet.")).toBeInTheDocument();
  });

  it("blocks Save on an out-of-range Context window", () => {
    renderEditForm([
      { id: "qwen", passthroughFileTypes: [], contextWindow: 131072 },
    ]);

    const dialog = openEditDialog("qwen");
    type(dialog, "Context window in tokens", "128");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      within(dialog).getByLabelText("Context window in tokens"),
    ).toHaveAttribute("aria-invalid", "true");
    expect(modelCard("qwen")).toHaveTextContent("Context window: 131,072");
  });

  it("sends each comma-separated native file type as its own entry", async () => {
    const fetchMock = stubAcceptedSave(ACCEPTED_SAVE);
    renderEditForm([{ id: "gpt-4o", passthroughFileTypes: ["image/*"] }]);

    const dialog = openEditDialog("gpt-4o");
    type(dialog, "Native file types", "image/png, application/pdf,");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    save();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedModelIds(fetchMock)[0].passthroughFileTypes).toEqual([
      "image/png",
      "application/pdf",
    ]);
  });

  // An empty list means "use the provider-type default", so a field holding
  // nothing but separators must not store an empty-string type.
  it("sends no native file types when the field holds only separators", async () => {
    const fetchMock = stubAcceptedSave(ACCEPTED_SAVE);
    renderEditForm([{ id: "gpt-4o", passthroughFileTypes: ["image/*"] }]);

    const dialog = openEditDialog("gpt-4o");
    type(dialog, "Native file types", " , ,");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    save();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedModelIds(fetchMock)[0].passthroughFileTypes).toEqual([]);
  });

  // Emptying the input has to actually clear the stored value. The whole
  // `modelIds` array is replaced on save, so an absent key is a real removal —
  // but only if the form stops sending the old number.
  it("clears a declared output ceiling when the input is emptied", async () => {
    const fetchMock = stubAcceptedSave(ACCEPTED_SAVE);
    renderEditForm([
      { id: "gpt-4o", passthroughFileTypes: [], maxOutputTokens: 64000 },
    ]);

    const dialog = openEditDialog("gpt-4o");
    type(dialog, "Max output tokens", "");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    save();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedModelIds(fetchMock)[0]).not.toHaveProperty("maxOutputTokens");
  });

  // `Number.parseInt` truncated at the first unreadable character, so `1e5`
  // became 1 — accepted by the schema, and every reply on the model then
  // stopped after one token. A number must be staged as typed or not at all.
  it.each([
    {
      field: "maxOutputTokens",
      label: "Max output tokens",
      typed: "1e5",
      sent: 100_000,
    },
    {
      field: "maxExtractedTextChars",
      label: "Max extracted text characters",
      typed: "2e4",
      sent: 20_000,
    },
  ])(
    "sends $label typed as $typed as the number it denotes",
    async ({ field, label, typed, sent }) => {
      const fetchMock = stubAcceptedSave(ACCEPTED_SAVE);
      renderEditForm([{ id: "gpt-4o", passthroughFileTypes: [] }]);

      const dialog = openEditDialog("gpt-4o");
      type(dialog, label, typed);
      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
      save();

      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(savedModelIds(fetchMock)[0][field]).toBe(sent);
    },
  );

  // A fraction is left for the schema's `.int()` to reject with a message,
  // never truncated into something storable.
  it("rejects a fractional Max output tokens in the dialog", () => {
    renderEditForm([{ id: "gpt-4o", passthroughFileTypes: [] }]);

    const dialog = openEditDialog("gpt-4o");
    type(dialog, "Max output tokens", "1.9");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(within(dialog).getByLabelText("Max output tokens")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("stages a model from the wizard's draft step", async () => {
    const write = vi.fn().mockResolvedValue({
      outcome: "success",
      data: undefined,
      revalidateKeys: [],
    });
    render(
      <ProviderForm
        orgId="org1"
        draft={{ write, onBack: vi.fn(), submitText: "Next" }}
      />,
    );

    const dialog = openAddDialog();
    type(dialog, "Model ID", "gpt-4o");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => expect(write).toHaveBeenCalled());
    expect(write.mock.calls[0][0].modelIds).toEqual([
      { id: "gpt-4o", passthroughFileTypes: [] },
    ]);
  });
});

describe("ProviderForm switching Providers", () => {
  // The form is reused across Providers within one mount. Populating from the
  // warm SWR cache has to repopulate on the switch too, not just on first load —
  // otherwise the reader would see the previous Provider's fields left on
  // screen under the new Provider's name.
  it("repopulates every field when the reader switches to another Provider, even from an already-warm cache", () => {
    setData({
      id: "p1",
      name: "OpenAI provider",
      providerType: "OpenAI",
      apiKey: "sk-p1",
      baseUrl: "https://p1.example.com",
      apiMode: "responses",
      modelIds: [{ id: "gpt-4o", passthroughFileTypes: [] }],
      taskModelId: "gpt-4o",
      memoryExtractionModelId: "gpt-4o",
    } as unknown as Provider);
    const { rerender } = render(<ProviderForm orgId="org1" providerId="p1" />);

    expect(screen.getByLabelText("Name")).toHaveValue("OpenAI provider");
    expect(modelCard("gpt-4o")).toBeInTheDocument();

    // Already resolved before the rerender, as it would be for a Provider
    // whose data is already warm in SWR's cache.
    setData({
      id: "p2",
      name: "Anthropic provider",
      providerType: "Anthropic",
      apiKey: "sk-p2",
      baseUrl: "https://p2.example.com",
      apiMode: "responses",
      modelIds: [{ id: "claude-opus", passthroughFileTypes: [] }],
      taskModelId: "claude-opus",
      memoryExtractionModelId: "claude-opus",
    } as unknown as Provider);
    rerender(<ProviderForm orgId="org1" providerId="p2" />);

    expect(screen.getByLabelText("Name")).toHaveValue("Anthropic provider");
    expect(screen.getByLabelText("API Key")).toHaveValue("sk-p2");
    expect(screen.getByLabelText("Base URL")).toHaveValue(
      "https://p2.example.com",
    );
    expect(modelCard("claude-opus")).toBeInTheDocument();
  });

  // The specific behaviour the old initialised-flag ref protected: a Provider
  // is populated once, and a later SWR revalidation of that *same* Provider —
  // a focus revalidation, another tab saving it — hands back a new object
  // reference for unchanged (or server-updated) data. That must not re-run
  // the populate and stomp an edit the reader hasn't saved yet. Keying the
  // reset on `providerId` (gated on the fetch having resolved) rather than on
  // `provider` itself is what keeps this working without the ref: `provider`
  // gets a new reference on every such revalidation, but `providerId` does not.
  it("does not clobber an in-progress edit when the same Provider's data revalidates", () => {
    const provider = {
      id: "p1",
      name: "OpenAI provider",
      providerType: "OpenAI",
      apiKey: "sk-p1",
      apiMode: "responses",
      modelIds: [{ id: "gpt-4o", passthroughFileTypes: [] }],
      taskModelId: "gpt-4o",
      memoryExtractionModelId: "gpt-4o",
    } as unknown as Provider;
    setData(provider);
    const { rerender } = render(<ProviderForm orgId="org1" providerId="p1" />);

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "My edited name" },
    });

    // A new object for the same Provider, as a revalidation would hand back.
    setData({ ...provider });
    rerender(<ProviderForm orgId="org1" providerId="p1" />);

    expect(screen.getByLabelText("Name")).toHaveValue("My edited name");
  });
});

describe("ProviderForm validation errors on model cards", () => {
  const threeModels = () => [
    { id: "a", passthroughFileTypes: [] },
    { id: "b", alias: "dup", passthroughFileTypes: [] },
    { id: "c", alias: "DUP", passthroughFileTypes: [] },
  ];

  // Keyed on the first path segment, both messages landed on the Models field
  // and the second overwrote the first: one message, one fix per round-trip,
  // and no indication of which model was wrong.
  it("marks every rejected card invalid with its own message", async () => {
    stubRejectedSave([
      { path: ["modelIds", 1, "alias"], message: "Alias 'dup' duplicates" },
      { path: ["modelIds", 2, "alias"], message: "Alias 'DUP' duplicates" },
    ]);

    renderEditForm(threeModels());
    save();

    expect(
      await within(modelCard("b")).findByText("Alias 'dup' duplicates"),
    ).toBeInTheDocument();
    expect(modelCard("c")).toHaveTextContent("Alias 'DUP' duplicates");
    expect(modelCard("a")).not.toHaveAttribute("data-invalid", "true");
    expect(modelCard("b")).toHaveAttribute("data-invalid", "true");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows a card's field error on the matching field in its Edit dialog", async () => {
    stubRejectedSave([
      { path: ["modelIds", 1, "alias"], message: "Alias 'dup' duplicates" },
    ]);

    renderEditForm(threeModels());
    save();
    await within(modelCard("b")).findByText("Alias 'dup' duplicates");

    const dialog = openEditDialog("b");
    expect(within(dialog).getByLabelText("Alias")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(within(dialog).getByLabelText("Model ID")).not.toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(dialog).toHaveTextContent("Alias 'dup' duplicates");
  });

  it("does not repeat a card's message against the Models field", async () => {
    stubRejectedSave([
      { path: ["modelIds", 1, "alias"], message: "Alias 'dup' duplicates" },
    ]);

    renderEditForm(threeModels());
    save();

    await waitFor(() =>
      expect(screen.getAllByText("Alias 'dup' duplicates")).toHaveLength(1),
    );
  });

  it("still shows an error reported against the list itself", async () => {
    stubRejectedSave([
      { path: ["modelIds"], message: "At least one model is required" },
    ]);

    renderEditForm([]);
    save();

    expect(
      await screen.findByText("At least one model is required"),
    ).toBeInTheDocument();
  });

  // The button used to be disabled while any error was outstanding, and errors
  // were only retracted by field-specific handlers. An error key with no
  // matching handler disabled Save with no way back but a reload.
  it("leaves Save usable after a rejection, so the retry is one click", async () => {
    stubRejectedSave([
      { path: ["modelIds", 1, "alias"], message: "Alias 'dup' duplicates" },
    ]);

    renderEditForm(threeModels());
    save();

    expect(
      await screen.findByText("Alias 'dup' duplicates"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update" })).toBeEnabled();
  });

  it.each([
    [
      "edit",
      () => {
        const dialog = openEditDialog("b");
        type(dialog, "Alias", "unique");
        fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
      },
    ],
    [
      "remove",
      () =>
        fireEvent.click(screen.getByRole("button", { name: "Remove model a" })),
    ],
    [
      "add",
      () => {
        const dialog = openAddDialog();
        type(dialog, "Model ID", "d");
        fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
      },
    ],
  ])(
    "retracts the card errors once a change is staged (%s)",
    async (_, stage) => {
      stubRejectedSave([
        { path: ["modelIds", 1, "alias"], message: "Alias 'dup' duplicates" },
        { path: ["modelIds", 2, "alias"], message: "Alias 'DUP' duplicates" },
      ]);

      renderEditForm(threeModels());
      save();
      await screen.findByText("Alias 'dup' duplicates");

      stage();

      expect(
        screen.queryByText("Alias 'dup' duplicates"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText("Alias 'DUP' duplicates"),
      ).not.toBeInTheDocument();
    },
  );
});

describe("ProviderForm Web search selector", () => {
  const CATALOG = [
    { backend: "acme-search.searx", name: "SearXNG", plugin: "acme-search" },
  ];

  /** Renders the edit form and opens the Advanced settings section the field sits in. */
  const renderWithAdvancedOpen = (overrides: Partial<Provider>) => {
    setData({
      id: "p1",
      name: "vLLM",
      providerType: "OpenAI",
      apiMode: "chat",
      apiKey: "sk-test",
      searchSource: "native",
      modelIds: [{ id: "qwen", passthroughFileTypes: [] }],
      taskModelId: "qwen",
      memoryExtractionModelId: "qwen",
      ...overrides,
    } as unknown as Provider);
    const result = render(<ProviderForm orgId="org1" providerId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: "Toggle" }));
    return result;
  };

  const searchSelect = () =>
    screen.queryByRole("combobox", { name: "Web search" });

  it("offers the installed backends, annotated with the plugin that contributed them", () => {
    setDataFor("/web-backends", { results: CATALOG });
    renderWithAdvancedOpen({
      searchSource: "acme-search.searx",
    } as Partial<Provider>);

    expect(searchSelect()).toHaveTextContent("SearXNG (acme-search)");
  });

  // vLLM (apiMode: "chat") has no native search, so it must not be offered a
  // "built-in search" option that resolves to nothing. Stored as "none" here:
  // a Provider already storing "native" is the one case the option does render,
  // named as unavailable, so that the stale value stays visible and clearable.
  it("omits the built-in search option for a Provider with no native search", () => {
    renderWithAdvancedOpen({ searchSource: "none" } as Partial<Provider>);

    expect(searchSelect()).not.toHaveTextContent("built-in search");
  });

  it("offers the built-in search option for a Provider that has native search", () => {
    renderWithAdvancedOpen({ apiMode: "responses" });

    expect(searchSelect()).toHaveTextContent("The provider's built-in search");
  });

  // A row backfilled to "native" (ADR-0014) with no native search of its own
  // — the default fixture here is exactly that shape, vLLM (chat mode) — must
  // not leave the select showing a value nothing in the list matches. The
  // field is present even with no backend installed (the default catalog).
  it.each([
    { name: "a chat-mode OpenAI Provider", overrides: {} },
    {
      name: "Bedrock",
      overrides: { providerType: "Bedrock" } as Partial<Provider>,
    },
  ])(
    "names a stale native selection as unavailable, for $name",
    ({ overrides }) => {
      renderWithAdvancedOpen(overrides);

      expect(searchSelect()).toHaveTextContent(
        "The provider's built-in search (unavailable here)",
      );
    },
  );

  // Naming it must not become rewriting it. `doSubmit` sends `searchSource` on
  // every save, so coercing the stored value would let a save that touched only
  // the name silently retire a selection nobody edited — one that resolves to no
  // search anyway while the capability is missing, and that comes back on its
  // own if the Provider regains a native tool.
  it("keeps a stale native selection stored when some other field is saved", async () => {
    const fetchMock = stubAcceptedSave(ACCEPTED_SAVE);

    renderWithAdvancedOpen({});
    expect(searchSelect()).toHaveTextContent("unavailable here");
    save();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedBody(fetchMock).searchSource).toBe("native");
  });

  // The other half of keeping it: picking None explicitly is a real edit, and
  // must overwrite the stored "native" rather than round-tripping it.
  it("stores none when the reader picks it on a Provider with no native search", async () => {
    const fetchMock = stubAcceptedSave(ACCEPTED_SAVE);

    renderWithAdvancedOpen({});

    await selectOption(searchSelect()!, "None");
    save();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedBody(fetchMock).searchSource).toBe("none");
  });

  // Switching Provider Type away from native search after "The provider's
  // built-in search" was selected takes that SelectItem out of the list — the
  // control would otherwise point at a value nothing matches until the page
  // reloads. Named as unavailable rather than cleared, so switching back
  // restores the selection instead of silently retiring it.
  it("names a selected built-in search unavailable when Provider Type loses native search", async () => {
    renderWithAdvancedOpen({ apiMode: "responses", searchSource: "native" });
    expect(searchSelect()).toHaveTextContent("The provider's built-in search");

    // Provider Type's SelectTrigger has no accessible name (a pre-existing
    // gap), so it is found by its current value instead.
    await selectOption("OpenAI", "Bedrock");

    expect(searchSelect()).toHaveTextContent(
      "The provider's built-in search (unavailable here)",
    );
  });

  // The round trip the naming exists to protect: an orphaned selection is still
  // there, and applies again, once the Provider is capable a second time.
  it("restores a selected built-in search when API Mode regains native search", async () => {
    renderWithAdvancedOpen({ apiMode: "chat", searchSource: "native" });
    expect(searchSelect()).toHaveTextContent("unavailable here");

    await selectOption("Chat Completions", "Responses");

    expect(searchSelect()).toHaveTextContent("The provider's built-in search");
    expect(searchSelect()).not.toHaveTextContent("unavailable here");
  });

  // Hiding the control would conceal a stored id nobody could then see or clear.
  it("shows a stored backend the catalog no longer lists, and names it as missing", () => {
    renderWithAdvancedOpen({ searchSource: "gone.searx" } as Partial<Provider>);

    expect(searchSelect()).toHaveTextContent("gone.searx (not installed)");
  });

  // An empty list means "none installed" only when the catalog actually answered.
  it("keeps the field and says so when the catalog could not be loaded", () => {
    setError(new Error("500"), "/web-backends");
    renderWithAdvancedOpen({});

    expect(searchSelect()).not.toBeNull();
    expect(
      screen.getByText(/Couldn't load the installed backends/),
    ).toBeInTheDocument();
  });

  // Calling an installed backend "not installed" because the request failed sends
  // an Operator hunting a plugin that is fine.
  it("does not call a stored backend uninstalled when the catalog failed", () => {
    setError(new Error("500"), "/web-backends");
    renderWithAdvancedOpen({
      searchSource: "acme-search.searx",
    } as Partial<Provider>);

    expect(searchSelect()).toHaveTextContent("acme-search.searx");
    expect(searchSelect()).not.toHaveTextContent("not installed");
  });

  it.each(["acme-search.searx", "none"])(
    "round-trips %s through a save",
    async (searchSource) => {
      setDataFor("/web-backends", { results: CATALOG });
      const fetchMock = stubAcceptedSave(ACCEPTED_SAVE);

      renderWithAdvancedOpen({ searchSource } as Partial<Provider>);
      save();

      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(savedBody(fetchMock).searchSource).toBe(searchSource);
    },
  );
});
