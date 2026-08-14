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

// The `GET /organizations/:orgId/web-backends` catalog. Empty by default, so the
// Web-search backend selector is absent for every test that predates it.
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

describe("ProviderForm Web-search backend selector", () => {
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
      nativeSearchEnabled: true,
      modelIds: [{ id: "qwen", passthroughFileTypes: [] }],
      taskModelId: "qwen",
      memoryExtractionModelId: "qwen",
      ...overrides,
    } as unknown as Provider;
    const result = render(<ProviderForm orgId="org1" providerId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: "Toggle" }));
    return result;
  };

  const webBackendSelect = () =>
    screen.queryByRole("combobox", { name: "Web-search backend" });

  /**
   * Opens the selector and picks None, by keyboard: Radix drives the pointer path
   * with capture APIs jsdom does not implement, and the keyboard route reaches the
   * same change. `scrollIntoView` is stubbed for the same reason — Radix calls it on
   * the highlighted option as the listbox mounts, and jsdom has no layout.
   */
  const selectNoBackend = async () => {
    const scrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = vi.fn();
    try {
      fireEvent.keyDown(webBackendSelect()!, { key: "ArrowDown" });
      const none = await screen.findByRole("option", { name: /^None/ });
      fireEvent.keyDown(none, { key: "Enter" });
    } finally {
      Element.prototype.scrollIntoView = scrollIntoView;
    }
  };

  it("is absent on a deployment with no Web-search backend installed", () => {
    renderWithAdvancedOpen({});

    expect(webBackendSelect()).toBeNull();
  });

  it("offers the installed backends, annotated with the plugin that contributed them", () => {
    webBackendCatalog = CATALOG;
    renderWithAdvancedOpen({
      webBackend: "acme-search.searx",
    } as Partial<Provider>);

    expect(webBackendSelect()).toHaveTextContent("SearXNG (acme-search)");
  });

  // The suffix has to come from the Provider's capability: on vLLM, "None" means
  // no web search at all, while on a native-capable Provider it selects the
  // built-in tool.
  it("says what None means for a Provider with no native search", () => {
    webBackendCatalog = CATALOG;
    renderWithAdvancedOpen({});

    expect(webBackendSelect()).toHaveTextContent("None — no web search");
  });

  it("says what None means for a Provider that has native search", () => {
    webBackendCatalog = CATALOG;
    renderWithAdvancedOpen({ apiMode: "responses" });

    expect(webBackendSelect()).toHaveTextContent(
      "None — use the built-in search",
    );
  });

  // Hiding the control would conceal a stored id nobody could then see or clear.
  it("shows a stored backend the catalog no longer lists, and names it as missing", () => {
    renderWithAdvancedOpen({ webBackend: "gone.searx" } as Partial<Provider>);

    expect(webBackendSelect()).toHaveTextContent("gone.searx (not installed)");
  });

  // An empty list means "none installed" only when the catalog actually answered.
  it("keeps the field and says so when the catalog could not be loaded", () => {
    webBackendCatalogError = new Error("500");
    renderWithAdvancedOpen({});

    expect(webBackendSelect()).not.toBeNull();
    expect(
      screen.getByText(/Couldn't load the installed backends/),
    ).toBeInTheDocument();
  });

  // Calling an installed backend "not installed" because the request failed sends
  // an Operator hunting a plugin that is fine.
  it("does not call a stored backend uninstalled when the catalog failed", () => {
    webBackendCatalogError = new Error("500");
    renderWithAdvancedOpen({
      webBackend: "acme-search.searx",
    } as Partial<Provider>);

    expect(webBackendSelect()).toHaveTextContent("acme-search.searx");
    expect(webBackendSelect()).not.toHaveTextContent("not installed");
  });

  // `nativeSearchEnabled` gates plugin search too and its name does not say so,
  // so the coupling is stated where the selection is made.
  it("warns that a selected backend will not run while native search is off", () => {
    webBackendCatalog = CATALOG;
    renderWithAdvancedOpen({
      nativeSearchEnabled: false,
      webBackend: "acme-search.searx",
    } as Partial<Provider>);

    expect(
      screen.getByText(
        /Native web search is off, so this backend will not run/,
      ),
    ).toBeInTheDocument();
    // Interactive, not disabled: disabling it would trap the stored value behind
    // the switch.
    expect(webBackendSelect()).not.toBeDisabled();
  });

  // The switch is not rendered on Bedrock, so the warning above would send an
  // Operator looking for a control that is not there. Only an API write reaches this
  // state, and only an API write leaves it.
  it("points at the API, not the switch, where the switch is not shown", () => {
    webBackendCatalog = CATALOG;
    renderWithAdvancedOpen({
      providerType: "Bedrock",
      nativeSearchEnabled: false,
      webBackend: "acme-search.searx",
    } as Partial<Provider>);

    expect(screen.queryByLabelText("Native web search")).toBeNull();
    expect(
      screen.getByText(/set back on through the Provider API/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/That switch allows web search at all/),
    ).toBeNull();
  });

  it("says nothing about the coupling while native search is on", () => {
    webBackendCatalog = CATALOG;
    renderWithAdvancedOpen({
      webBackend: "acme-search.searx",
    } as Partial<Provider>);

    expect(screen.queryByText(/Native web search is off/)).toBeNull();
  });

  // The recovery path for a stale id on a deployment where nothing is installed:
  // choosing None empties `webBackend`, which is the same value the field's own
  // visibility condition reads. Unlatched, the control unmounted here — mid-
  // interaction, before the save, with no undo short of a reload.
  it("keeps the field mounted after the stored backend is cleared", async () => {
    renderWithAdvancedOpen({ webBackend: "gone.searx" } as Partial<Provider>);

    await selectNoBackend();

    expect(webBackendSelect()).not.toBeNull();
    expect(webBackendSelect()).toHaveTextContent("None");
  });

  it("round-trips the stored backend through a save", async () => {
    webBackendCatalog = CATALOG;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    renderWithAdvancedOpen({
      webBackend: "acme-search.searx",
    } as Partial<Provider>);
    save();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.webBackend).toBe("acme-search.searx");
  });

  // `""` would be a second representation of "no backend"; the API normalises it,
  // but the form should not send it in the first place.
  it("sends null, not an empty string, when no backend is selected", async () => {
    webBackendCatalog = CATALOG;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    renderWithAdvancedOpen({});
    save();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.webBackend).toBeNull();
  });
});
