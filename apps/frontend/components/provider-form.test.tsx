import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Provider } from "@platypus/schemas";

// --- Module mocks ------------------------------------------------------------

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("@/app/client-context", () => ({
  useBackendUrl: () => "http://test",
}));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { id: "u1" } }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

// The provider the edit form loads. Set per test before rendering.
let loadedProvider: Provider | undefined;

// The `GET /organizations/:orgId/web-backends` catalog. Empty by default —
// the Web search selector offers only None (and the built-in search option,
// where the provider has one) for every test that predates it.
let webBackendCatalog: Array<{
  backend: string;
  name: string;
  plugin: string | null;
}> = [];

// Set to make the catalog request fail instead of resolving, so the "we could not
// ask" state is distinguishable from "nothing installed".
let webBackendCatalogError: Error | undefined;

// Keyed on the request URL: the form now makes two calls, and returning the
// loaded Provider for the catalog one would hand the selector a `results`-less
// object.
vi.mock("swr", () => ({
  __esModule: true,
  default: (key: string | null) => {
    if (key?.includes("/web-backends")) {
      return {
        data: webBackendCatalogError
          ? undefined
          : { results: webBackendCatalog },
        error: webBackendCatalogError,
        isLoading: false,
        mutate: vi.fn(),
      };
    }
    return { data: loadedProvider, isLoading: false, mutate: vi.fn() };
  },
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));

import { ProviderForm } from "./provider-form";

// --- Helpers -----------------------------------------------------------------

function renderEditForm(modelIds: Provider["modelIds"]) {
  loadedProvider = {
    id: "p1",
    name: "OpenAI",
    providerType: "OpenAI",
    apiKey: "sk-test",
    apiMode: "responses",
    modelIds,
    taskModelId: "gpt-4o",
    memoryExtractionModelId: "gpt-4o",
  } as unknown as Provider;
  return render(<ProviderForm orgId="org1" providerId="p1" />);
}

/** A server rejection carrying standardschema issues, as the API returns them. */
function mockRejectedSave(issues: Array<{ path: unknown[]; message: string }>) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status: 400,
    json: async () => ({ error: issues }),
  } as unknown as Response);
}

/** An accepted save, so the payload the form sent can be read back. */
function mockAcceptedSave() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ id: "p1", aliasRepoints: [] }),
  } as unknown as Response);
}

/** `mockAcceptedSave`, installed as the global `fetch` and handed back to read. */
function stubAcceptedSave() {
  const fetchMock = mockAcceptedSave();
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The `modelIds` the form put on the wire for the last save. */
function savedModelIds(fetchMock: ReturnType<typeof vi.fn>) {
  const [, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return JSON.parse(String(init.body)).modelIds;
}

const save = () =>
  fireEvent.click(screen.getByRole("button", { name: "Update" }));

// --- Tests -------------------------------------------------------------------

describe("ProviderForm model rows", () => {
  afterEach(() => {
    loadedProvider = undefined;
    vi.restoreAllMocks();
  });

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
    const fetchMock = mockAcceptedSave();
    vi.stubGlobal("fetch", fetchMock);

    renderEditForm([
      { id: "gpt-4o", passthroughFileTypes: [], contextWindow: 200000 },
    ]);
    save();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedModelIds(fetchMock)).toEqual([
      { id: "gpt-4o", passthroughFileTypes: [], contextWindow: 200000 },
    ]);
  });

  // The field is optional on both create and update: a row that never touches
  // it must not start sending a number the Org Admin did not declare.
  it("declares no window for a row that was left alone", async () => {
    const fetchMock = mockAcceptedSave();
    vi.stubGlobal("fetch", fetchMock);

    renderEditForm([{ id: "gpt-4o", passthroughFileTypes: [] }]);
    save();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedModelIds(fetchMock)[0].contextWindow).toBeUndefined();
  });

  // Editing a Custom value types straight through, bounds included, so a `128`
  // meant as 128k is rejected by the server rather than silently swallowed.
  it("sends a typed Custom value exactly as typed", async () => {
    const fetchMock = mockAcceptedSave();
    vi.stubGlobal("fetch", fetchMock);

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
    const fetchMock = mockAcceptedSave();
    vi.stubGlobal("fetch", fetchMock);

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
    const fetchMock = mockAcceptedSave();
    vi.stubGlobal("fetch", fetchMock);

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
  // then stopped after one token. A ceiling must reach the server as typed or
  // not at all.
  it("reads an exponent in the output ceiling as the number it denotes", async () => {
    const fetchMock = mockAcceptedSave();
    vi.stubGlobal("fetch", fetchMock);

    renderEditForm([
      { id: "gpt-4o", passthroughFileTypes: [], maxOutputTokens: 64000 },
    ]);
    fireEvent.change(screen.getByLabelText("Max output tokens"), {
      target: { value: "1e5" },
    });
    save();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedModelIds(fetchMock)[0].maxOutputTokens).toBe(100_000);
  });

  // Passed through as typed rather than floored to 1: the schema's `.int()`
  // rejects it with a message the reader can act on, which is the whole point of
  // not coercing here.
  it("sends a fractional output ceiling as typed, for the schema to reject", async () => {
    const fetchMock = mockAcceptedSave();
    vi.stubGlobal("fetch", fetchMock);

    renderEditForm([
      { id: "gpt-4o", passthroughFileTypes: [], maxOutputTokens: 64000 },
    ]);
    fireEvent.change(screen.getByLabelText("Max output tokens"), {
      target: { value: "1.9" },
    });
    save();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedModelIds(fetchMock)[0].maxOutputTokens).toBe(1.9);
  });

  // The extracted-text cap shares the parser, so it shares the fix.
  it("reads an exponent in the extracted-text cap as the number it denotes", async () => {
    const fetchMock = mockAcceptedSave();
    vi.stubGlobal("fetch", fetchMock);

    renderEditForm([
      { id: "gpt-4o", passthroughFileTypes: [], maxExtractedTextChars: 1000 },
    ]);
    fireEvent.change(screen.getByLabelText("Max extracted text characters"), {
      target: { value: "2e4" },
    });
    save();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedModelIds(fetchMock)[0].maxExtractedTextChars).toBe(20_000);
  });

  it("declares no output ceiling for a row that was left alone", async () => {
    const fetchMock = mockAcceptedSave();
    vi.stubGlobal("fetch", fetchMock);

    renderEditForm([{ id: "gpt-4o", passthroughFileTypes: [] }]);
    save();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedModelIds(fetchMock)[0].maxOutputTokens).toBeUndefined();
  });

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

describe("ProviderForm validation errors on model rows", () => {
  afterEach(() => {
    loadedProvider = undefined;
    vi.restoreAllMocks();
  });

  const threeModels = () => [
    { id: "a", passthroughFileTypes: [] },
    { id: "b", alias: "dup", passthroughFileTypes: [] },
    { id: "c", alias: "DUP", passthroughFileTypes: [] },
  ];

  // Keyed on the first path segment, both messages landed on the Models field
  // and the second overwrote the first: one message, one fix per round-trip,
  // and no indication of which row was wrong.
  it("shows every rejected row its own message, against the field that failed", async () => {
    vi.stubGlobal(
      "fetch",
      mockRejectedSave([
        { path: ["modelIds", 1, "alias"], message: "Alias 'dup' duplicates" },
        { path: ["modelIds", 2, "alias"], message: "Alias 'DUP' duplicates" },
      ]),
    );

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
    vi.stubGlobal(
      "fetch",
      mockRejectedSave([
        { path: ["modelIds", 1, "alias"], message: "Alias 'dup' duplicates" },
      ]),
    );

    renderEditForm(threeModels());
    save();

    await waitFor(() =>
      expect(screen.getAllByText("Alias 'dup' duplicates")).toHaveLength(1),
    );
  });

  it("still shows an error reported against the list itself", async () => {
    vi.stubGlobal(
      "fetch",
      mockRejectedSave([
        { path: ["modelIds"], message: "At least one model is required" },
      ]),
    );

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
    vi.stubGlobal(
      "fetch",
      mockRejectedSave([
        { path: ["modelIds", 1, "alias"], message: "Alias 'dup' duplicates" },
      ]),
    );

    renderEditForm(threeModels());
    save();

    await waitFor(() =>
      expect(screen.getByText("Alias 'dup' duplicates")).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Update" })).toBeEnabled();
  });

  it("retracts the row errors once the list is edited", async () => {
    vi.stubGlobal(
      "fetch",
      mockRejectedSave([
        { path: ["modelIds", 1, "alias"], message: "Alias 'dup' duplicates" },
        { path: ["modelIds", 2, "alias"], message: "Alias 'DUP' duplicates" },
      ]),
    );

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
    vi.stubGlobal(
      "fetch",
      mockRejectedSave([
        {
          path: ["modelIds", 0, "maxExtractedTextChars"],
          message: "Too small",
        },
      ]),
    );

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
    vi.stubGlobal(
      "fetch",
      mockRejectedSave([
        {
          path: ["modelIds", 0, "maxOutputTokens"],
          message: "Too small: expected number to be >0",
        },
      ]),
    );

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
    vi.stubGlobal(
      "fetch",
      mockRejectedSave([
        {
          path: ["modelIds", 0, "contextWindow"],
          message: "Too small: expected number to be >=1000",
        },
      ]),
    );

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
  afterEach(() => {
    loadedProvider = undefined;
    webBackendCatalog = [];
    webBackendCatalogError = undefined;
    vi.restoreAllMocks();
  });

  const CATALOG = [
    { backend: "acme-search.searx", name: "SearXNG", plugin: "acme-search" },
  ];

  /** Renders the edit form and opens the Advanced settings section the field sits in. */
  const renderWithAdvancedOpen = (overrides: Partial<Provider>) => {
    loadedProvider = {
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
    } as unknown as Provider;
    const result = render(<ProviderForm orgId="org1" providerId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: "Toggle" }));
    return result;
  };

  const searchSelect = () =>
    screen.queryByRole("combobox", { name: "Web search" });

  it("is always present, even on a deployment with no backend installed", () => {
    renderWithAdvancedOpen({});

    expect(searchSelect()).not.toBeNull();
  });

  it("offers the installed backends, annotated with the plugin that contributed them", () => {
    webBackendCatalog = CATALOG;
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
  // not leave the select showing a value nothing in the list matches.
  it("names a stale native selection as unavailable, for a Provider with no native search", () => {
    renderWithAdvancedOpen({});

    expect(searchSelect()).toHaveTextContent(
      "The provider's built-in search (unavailable here)",
    );
  });

  it("names a stale native selection as unavailable, for Bedrock too", () => {
    renderWithAdvancedOpen({ providerType: "Bedrock" });

    expect(searchSelect()).toHaveTextContent(
      "The provider's built-in search (unavailable here)",
    );
  });

  // Naming it must not become rewriting it. `doSubmit` sends `searchSource` on
  // every save, so coercing the stored value would let a save that touched only
  // the name silently retire a selection nobody edited — one that resolves to no
  // search anyway while the capability is missing, and that comes back on its
  // own if the Provider regains a native tool.
  it("keeps a stale native selection stored when some other field is saved", async () => {
    const fetchMock = stubAcceptedSave();

    renderWithAdvancedOpen({});
    expect(searchSelect()).toHaveTextContent("unavailable here");
    save();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.searchSource).toBe("native");
  });

  // The other half of keeping it: picking None explicitly is a real edit, and
  // must overwrite the stored "native" rather than round-tripping it.
  it("stores none when the reader picks it on a Provider with no native search", async () => {
    const fetchMock = stubAcceptedSave();

    renderWithAdvancedOpen({});

    const scrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = vi.fn();
    try {
      fireEvent.keyDown(searchSelect()!, { key: "ArrowDown" });
      const none = await screen.findByRole("option", { name: "None" });
      fireEvent.keyDown(none, { key: "Enter" });
    } finally {
      Element.prototype.scrollIntoView = scrollIntoView;
    }
    save();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.searchSource).toBe("none");
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
    const providerTypeSelect = screen
      .getAllByRole("combobox")
      .find((el) => el.textContent === "OpenAI")!;

    const scrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = vi.fn();
    try {
      fireEvent.keyDown(providerTypeSelect, { key: "ArrowDown" });
      const bedrock = await screen.findByRole("option", { name: "Bedrock" });
      fireEvent.keyDown(bedrock, { key: "Enter" });
    } finally {
      Element.prototype.scrollIntoView = scrollIntoView;
    }

    expect(searchSelect()).toHaveTextContent(
      "The provider's built-in search (unavailable here)",
    );
  });

  // The round trip the naming exists to protect: an orphaned selection is still
  // there, and applies again, once the Provider is capable a second time.
  it("restores a selected built-in search when API Mode regains native search", async () => {
    renderWithAdvancedOpen({ apiMode: "chat", searchSource: "native" });
    expect(searchSelect()).toHaveTextContent("unavailable here");

    const apiModeSelect = screen
      .getAllByRole("combobox")
      .find((el) => el.textContent === "Chat Completions")!;

    const scrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = vi.fn();
    try {
      fireEvent.keyDown(apiModeSelect, { key: "ArrowDown" });
      const responses = await screen.findByRole("option", {
        name: "Responses",
      });
      fireEvent.keyDown(responses, { key: "Enter" });
    } finally {
      Element.prototype.scrollIntoView = scrollIntoView;
    }

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
    webBackendCatalogError = new Error("500");
    renderWithAdvancedOpen({});

    expect(searchSelect()).not.toBeNull();
    expect(
      screen.getByText(/Couldn't load the installed backends/),
    ).toBeInTheDocument();
  });

  // Calling an installed backend "not installed" because the request failed sends
  // an Operator hunting a plugin that is fine.
  it("does not call a stored backend uninstalled when the catalog failed", () => {
    webBackendCatalogError = new Error("500");
    renderWithAdvancedOpen({
      searchSource: "acme-search.searx",
    } as Partial<Provider>);

    expect(searchSelect()).toHaveTextContent("acme-search.searx");
    expect(searchSelect()).not.toHaveTextContent("not installed");
  });

  it("round-trips the stored backend through a save", async () => {
    webBackendCatalog = CATALOG;
    const fetchMock = stubAcceptedSave();

    renderWithAdvancedOpen({
      searchSource: "acme-search.searx",
    } as Partial<Provider>);
    save();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.searchSource).toBe("acme-search.searx");
  });

  it("round-trips none through a save", async () => {
    webBackendCatalog = CATALOG;
    const fetchMock = stubAcceptedSave();

    renderWithAdvancedOpen({ searchSource: "none" } as Partial<Provider>);
    save();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.searchSource).toBe("none");
  });
});
