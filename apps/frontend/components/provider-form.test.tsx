import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Provider } from "@platypus/schemas";
import {
  navigationMock,
  authMock,
  toastMock,
  swrMock,
  setData,
  setDataFor,
  setError,
  resetFormHarness,
  stubAcceptedSave,
  stubRejectedSave,
  savedBody,
} from "@/lib/form-test-harness";
import { selectOption } from "@/lib/test-utils";

// --- Module mocks ------------------------------------------------------------

vi.mock("next/navigation", () => navigationMock);
vi.mock("@/components/auth-provider", () => authMock);
vi.mock("sonner", () => toastMock);
// The form makes two reads: the Provider being edited, and the
// `GET /organizations/:orgId/web-backends` catalog. The harness keys its
// responses off the request URL suffix so the catalog read does not get
// handed the Provider, which carries no `results`.
vi.mock("swr", () => swrMock);

import { ProviderForm } from "./provider-form";

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
  return render(<ProviderForm orgId="org1" providerId="p1" />);
}

/** The `modelIds` the form put on the wire for the last save. */
function savedModelIds(fetchMock: ReturnType<typeof vi.fn>) {
  return savedBody(fetchMock).modelIds;
}

const save = () =>
  fireEvent.click(screen.getByRole("button", { name: "Update" }));

beforeEach(() => {
  resetFormHarness();
  // Empty by default — the Web search selector offers only None (and the
  // built-in search option, where the Provider has one) for every test that
  // predates the catalog.
  setDataFor("/web-backends", { results: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- Tests -------------------------------------------------------------------

describe("ProviderForm model rows", () => {
  it("labels the Model ID input rather than relying on its placeholder", () => {
    renderEditForm([{ id: "gpt-4o", passthroughFileTypes: [] }]);

    expect(screen.getByLabelText("Model ID")).toHaveValue("gpt-4o");
  });

  it("gives every model field an info control carrying its help text", () => {
    renderEditForm([{ id: "gpt-4o", passthroughFileTypes: ["image/*"] }]);

    for (const label of [
      "Model ID",
      "Alias",
      "Context window",
      "Native file types",
      "Max extracted text characters",
      "Max output tokens",
    ]) {
      expect(
        screen.getByRole("button", { name: `About ${label}` }),
      ).toBeInTheDocument();
    }
  });

  it("hides the file-handling fields until the row is expanded", () => {
    renderEditForm([{ id: "gpt-4o", passthroughFileTypes: [] }]);

    expect(screen.queryByLabelText("Native file types")).toBeNull();
    expect(screen.queryByLabelText("Max extracted text characters")).toBeNull();
    expect(screen.queryByLabelText("Max output tokens")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));

    expect(screen.getByLabelText("Native file types")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Max extracted text characters"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Max output tokens")).toBeInTheDocument();
  });

  // Unlike the file-handling pair, this one is visible on a collapsed row: an
  // Org Admin who never opens Advanced still has to find out the field exists,
  // because nothing else can tell Platypus a model's capacity.
  it("shows the Context window control without expanding Advanced", () => {
    renderEditForm([{ id: "gpt-4o", passthroughFileTypes: [] }]);

    expect(screen.getByLabelText("Context window")).toBeInTheDocument();
    expect(screen.getByLabelText("Context window")).toHaveTextContent(
      "Not set",
    );
  });

  it("shows a stored listed size on the closed control", () => {
    renderEditForm([
      { id: "gpt-4o", passthroughFileTypes: [], contextWindow: 128000 },
    ]);

    expect(screen.getByLabelText("Context window")).toHaveTextContent("128k");
    expect(screen.queryByLabelText("Context window in tokens")).toBeNull();
  });

  // A proxied model with an unusual capacity comes back in the number input
  // rather than snapping to whichever preset happens to be nearest.
  it("shows a stored unlisted size as a Custom value in the number input", () => {
    renderEditForm([
      { id: "qwen", passthroughFileTypes: [], contextWindow: 131072 },
    ]);

    expect(screen.getByLabelText("Context window")).toHaveTextContent("Custom");
    expect(screen.getByLabelText("Context window in tokens")).toHaveValue(
      131072,
    );
  });

  // Rows are keyed by index, so removing one shifts the row above's local state
  // onto its neighbour. The control has to survive that: a trigger reading
  // "Custom" beside no input would leave a declared window invisible and
  // uneditable until the page was reloaded.
  it("keeps a Custom value editable after the row above it is removed", () => {
    renderEditForm([
      { id: "gpt-4o", passthroughFileTypes: [] },
      { id: "qwen", passthroughFileTypes: [], contextWindow: 131072 },
    ]);

    fireEvent.click(screen.getByLabelText("Remove model 1"));

    expect(screen.getByLabelText("Model ID")).toHaveValue("qwen");
    expect(screen.getByLabelText("Context window")).toHaveTextContent("Custom");
    expect(screen.getByLabelText("Context window in tokens")).toHaveValue(
      131072,
    );
  });

  it("leaves a legacy string model row loadable with no window declared", () => {
    renderEditForm(["gpt-4o"] as unknown as Provider["modelIds"]);

    expect(screen.getByLabelText("Model ID")).toHaveValue("gpt-4o");
    expect(screen.getByLabelText("Context window")).toHaveTextContent(
      "Not set",
    );
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

  // Both fields are optional on create and update: a row that never touches
  // them must not start sending a number the Org Admin did not declare.
  it("declares no window and no output ceiling for a row that was left alone", async () => {
    const fetchMock = stubAcceptedSave(ACCEPTED_SAVE);

    renderEditForm([{ id: "gpt-4o", passthroughFileTypes: [] }]);
    save();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedModelIds(fetchMock)).toEqual([
      { id: "gpt-4o", passthroughFileTypes: [] },
    ]);
  });

  // Editing a Custom value types straight through, bounds included, so a `128`
  // meant as 128k is rejected by the server rather than silently swallowed.
  it("sends a typed Custom value exactly as typed", async () => {
    const fetchMock = stubAcceptedSave(ACCEPTED_SAVE);

    renderEditForm([
      { id: "qwen", passthroughFileTypes: [], contextWindow: 131072 },
    ]);
    fireEvent.change(screen.getByLabelText("Context window in tokens"), {
      target: { value: "128" },
    });
    save();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedModelIds(fetchMock)[0].contextWindow).toBe(128);
  });

  it("opens a row already carrying file-handling config, so nothing set is hidden", () => {
    renderEditForm([
      {
        id: "gpt-4o",
        passthroughFileTypes: ["image/*", "application/pdf"],
        maxExtractedTextChars: 1000,
      },
    ]);

    expect(screen.getByLabelText("Native file types")).toHaveValue(
      "image/*, application/pdf",
    );
    expect(screen.getByLabelText("Max extracted text characters")).toHaveValue(
      1000,
    );
  });

  // Same rule as the file-handling pair: a ceiling someone declared must not be
  // hidden behind a collapsed section where the next reader won't find it.
  it("opens a row whose only Advanced setting is a declared output ceiling", () => {
    renderEditForm([
      { id: "gpt-4o", passthroughFileTypes: [], maxOutputTokens: 64000 },
    ]);

    expect(screen.getByLabelText("Max output tokens")).toHaveValue(64000);
  });

  it("sends a declared output ceiling back unchanged, so it survives a save", async () => {
    const fetchMock = stubAcceptedSave(ACCEPTED_SAVE);

    renderEditForm([
      { id: "gpt-4o", passthroughFileTypes: [], maxOutputTokens: 64000 },
    ]);
    save();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedModelIds(fetchMock)[0].maxOutputTokens).toBe(64000);
  });

  // Emptying the input has to actually clear the stored value. The whole
  // `modelIds` array is replaced on save, so an absent key is a real removal —
  // but only if the form stops sending the old number.
  it("clears a declared output ceiling when the input is emptied", async () => {
    const fetchMock = stubAcceptedSave(ACCEPTED_SAVE);

    renderEditForm([
      { id: "gpt-4o", passthroughFileTypes: [], maxOutputTokens: 64000 },
    ]);
    fireEvent.change(screen.getByLabelText("Max output tokens"), {
      target: { value: "" },
    });
    save();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedModelIds(fetchMock)[0]).not.toHaveProperty("maxOutputTokens");
  });

  // `Number.parseInt` truncated at the first unreadable character, so `1e5` and
  // `1.9` both saved as 1 — accepted by the schema, and every reply on the model
  // then stopped after one token. A number must reach the server as typed or
  // not at all: a fraction is left for the schema's `.int()` to reject with a
  // message the reader can act on. The extracted-text cap shares the parser.
  it.each([
    {
      field: "maxOutputTokens",
      label: "Max output tokens",
      typed: "1e5",
      sent: 100_000,
    },
    {
      field: "maxOutputTokens",
      label: "Max output tokens",
      typed: "1.9",
      sent: 1.9,
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

      renderEditForm([
        { id: "gpt-4o", passthroughFileTypes: [], [field]: 1000 },
      ]);
      fireEvent.change(screen.getByLabelText(label), {
        target: { value: typed },
      });
      save();

      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(savedModelIds(fetchMock)[0][field]).toBe(sent);
    },
  );

  it("expands only the row that has config, leaving its neighbours collapsed", () => {
    renderEditForm([
      { id: "gpt-4o", passthroughFileTypes: [] },
      { id: "gpt-4o-mini", passthroughFileTypes: ["image/*"] },
    ]);

    // One expanded row means one visible pair of file-handling inputs.
    expect(screen.getAllByLabelText("Native file types")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Advanced" })).toHaveLength(2);
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
    expect(screen.getByLabelText("Model ID")).toHaveValue("gpt-4o");

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
    expect(screen.getByLabelText("Model ID")).toHaveValue("claude-opus");
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

describe("ProviderForm validation errors on model rows", () => {
  const threeModels = () => [
    { id: "a", passthroughFileTypes: [] },
    { id: "b", alias: "dup", passthroughFileTypes: [] },
    { id: "c", alias: "DUP", passthroughFileTypes: [] },
  ];

  // Keyed on the first path segment, both messages landed on the Models field
  // and the second overwrote the first: one message, one fix per round-trip,
  // and no indication of which row was wrong.
  it("shows every rejected row its own message, against the field that failed", async () => {
    stubRejectedSave([
      { path: ["modelIds", 1, "alias"], message: "Alias 'dup' duplicates" },
      { path: ["modelIds", 2, "alias"], message: "Alias 'DUP' duplicates" },
    ]);

    renderEditForm(threeModels());
    save();

    await waitFor(() =>
      expect(screen.getByText("Alias 'dup' duplicates")).toBeInTheDocument(),
    );
    expect(screen.getByText("Alias 'DUP' duplicates")).toBeInTheDocument();

    // The message lands on the row that failed, not on its neighbours.
    const aliases = screen.getAllByLabelText("Alias");
    expect(aliases[0]).not.toHaveAttribute("aria-invalid", "true");
    expect(aliases[1]).toHaveAttribute("aria-invalid", "true");
    expect(aliases[2]).toHaveAttribute("aria-invalid", "true");
  });

  it("does not repeat a row's message against the Models field", async () => {
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

    await waitFor(() =>
      expect(
        screen.getByText("At least one model is required"),
      ).toBeInTheDocument(),
    );
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

    await waitFor(() =>
      expect(screen.getByText("Alias 'dup' duplicates")).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Update" })).toBeEnabled();
  });

  it("retracts the row errors once the list is edited", async () => {
    stubRejectedSave([
      { path: ["modelIds", 1, "alias"], message: "Alias 'dup' duplicates" },
      { path: ["modelIds", 2, "alias"], message: "Alias 'DUP' duplicates" },
    ]);

    renderEditForm(threeModels());
    save();

    await waitFor(() =>
      expect(screen.getByText("Alias 'dup' duplicates")).toBeInTheDocument(),
    );

    fireEvent.change(screen.getAllByLabelText("Alias")[1], {
      target: { value: "unique" },
    });

    expect(screen.queryByText("Alias 'dup' duplicates")).toBeNull();
    expect(screen.queryByText("Alias 'DUP' duplicates")).toBeNull();
  });

  it("opens a collapsed row when the server rejects a field inside it", async () => {
    stubRejectedSave([
      {
        path: ["modelIds", 0, "maxExtractedTextChars"],
        message: "Too small",
      },
    ]);

    renderEditForm([{ id: "a", passthroughFileTypes: [] }]);
    expect(screen.queryByLabelText("Max extracted text characters")).toBeNull();

    save();

    await waitFor(() =>
      expect(
        screen.getByLabelText("Max extracted text characters"),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("Too small")).toBeInTheDocument();
  });

  it("opens a collapsed row when the server rejects its output ceiling", async () => {
    stubRejectedSave([
      {
        path: ["modelIds", 0, "maxOutputTokens"],
        message: "Too small: expected number to be >0",
      },
    ]);

    renderEditForm([{ id: "a", passthroughFileTypes: [] }]);
    expect(screen.queryByLabelText("Max output tokens")).toBeNull();

    save();

    await waitFor(() =>
      expect(screen.getByLabelText("Max output tokens")).toBeInTheDocument(),
    );
    expect(
      screen.getByText("Too small: expected number to be >0"),
    ).toBeInTheDocument();
  });

  // The window sits outside Advanced, so its rejection needs no disclosure
  // opened — it lands on a control the reader is already looking at.
  it("shows a rejected Context window against the control itself", async () => {
    stubRejectedSave([
      {
        path: ["modelIds", 0, "contextWindow"],
        message: "Too small: expected number to be >=1000",
      },
    ]);

    renderEditForm([{ id: "a", passthroughFileTypes: [], contextWindow: 128 }]);
    save();

    await waitFor(() =>
      expect(
        screen.getByText("Too small: expected number to be >=1000"),
      ).toBeInTheDocument(),
    );
    expect(screen.getByLabelText("Context window")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });
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
