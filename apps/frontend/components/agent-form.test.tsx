import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import {
  agentCreateSchema,
  agentUpdateSchema,
  type Provider,
  type ToolSet,
} from "@platypus/schemas";
import {
  authMock,
  swrMock,
  push,
  toastError,
  toastSuccess,
  setData,
  setDataFor,
  resetFormHarness,
  setLoading,
  setupUser,
  stubAcceptedSave,
  stubRejectedSave,
  stubSaveSequence,
} from "@/test/form-test-harness";
import { expectSentBodyToMatchSchema, selectOption } from "@/test/test-utils";

// --- Module mocks ------------------------------------------------------------

vi.mock("@/components/auth-provider", () => authMock);
// useSWR is called for providers, skills, agents, and (when editing) the
// agent. The harness keys its responses off the request URL suffix, so
// each call gets the right payload; a key with no matcher (skills, the
// agents list) falls back to the default set below.
vi.mock("swr", () => swrMock);

import { AgentForm } from "./agent-form";
import { FIX_FORM_ERRORS_MESSAGE } from "@/lib/apply-write-outcome";

// --- Helpers -----------------------------------------------------------------

const provider: Provider = {
  id: "p1",
  name: "OpenAI",
  providerType: "OpenAI",
  apiMode: "chat",
  modelIds: [{ id: "gpt-4o", passthroughFileTypes: [] }],
} as unknown as Provider;

// Registered fresh in each test's beforeEach (below) since resetFormHarness
// clears the harness's data-fetching registrations along with its spies.
function registerSwrData() {
  setData({ results: [] });
  setDataFor("/providers", { results: [provider] });
}

function renderCreateForm() {
  return render(
    <AgentForm orgId="org1" workspaceId="ws1" toolSets={[]} agents={[]} />,
  );
}

// --- Tests -------------------------------------------------------------------

describe("AgentForm validation error surfacing", () => {
  beforeEach(() => {
    resetFormHarness();
    registerSwrData();
  });

  it("renders an inline error and marks the Model control invalid when the server rejects modelId", async () => {
    stubRejectedSave([{ path: ["modelId"], message: "Model is required" }]);

    renderCreateForm();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Model is required")).toBeInTheDocument();

    // The Model select trigger is marked invalid for assistive tech.
    const trigger = screen.getByRole("combobox", { name: "Model" });
    expect(trigger).toHaveAttribute("aria-invalid", "true");

    // A validation failure is never silent.
    expect(toastError).toHaveBeenCalledWith(FIX_FORM_ERRORS_MESSAGE);
  });

  it("shows the server's message when the failure maps to no inline field", async () => {
    stubRejectedSave("something went wrong on the server");

    renderCreateForm();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "something went wrong on the server",
      ),
    );
  });

  it("clears a field's error and re-enables Save once the field is edited", async () => {
    stubRejectedSave([{ path: ["maxSteps"], message: "Invalid max steps" }]);

    renderCreateForm();

    const saveButton = screen.getByRole("button", { name: "Save" });
    fireEvent.click(saveButton);

    expect(await screen.findByText("Invalid max steps")).toBeInTheDocument();
    // An unshown error must not silently disable the button — but a shown one
    // does, until the user corrects the field.
    expect(saveButton).toBeDisabled();

    // Editing the offending field clears its error and re-enables Save.
    fireEvent.change(screen.getByLabelText("Max steps"), {
      target: { value: "10" },
    });

    await waitFor(() =>
      expect(screen.queryByText("Invalid max steps")).not.toBeInTheDocument(),
    );
    expect(saveButton).toBeEnabled();
  });

  it("clears a sampling field's error and re-enables Save once that field is edited", async () => {
    stubRejectedSave([
      { path: ["temperature"], message: "Temperature is required" },
    ]);

    renderCreateForm();

    fireEvent.click(screen.getByText("Advanced settings"));
    const saveButton = screen.getByRole("button", { name: "Save" });
    fireEvent.click(saveButton);

    expect(
      await screen.findByText("Temperature is required"),
    ).toBeInTheDocument();
    expect(saveButton).toBeDisabled();

    // The shared SamplingControls reports a patch, so the form itself must
    // retract the error keyed to the field that changed (#1941).
    fireEvent.change(screen.getByLabelText("Temperature"), {
      target: { value: "0.5" },
    });

    await waitFor(() =>
      expect(
        screen.queryByText("Temperature is required"),
      ).not.toBeInTheDocument(),
    );
    expect(saveButton).toBeEnabled();
  });

  // #571: toolSetIds has no field that retracts its error, so gating Save on
  // it would disable Save forever with no way out but reloading.
  it("never disables Save on a rejection keyed to a field with no retracting input", async () => {
    stubRejectedSave([{ path: ["toolSetIds"], message: "Unknown tool set" }]);

    renderCreateForm();

    const saveButton = screen.getByRole("button", { name: "Save" });
    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(FIX_FORM_ERRORS_MESSAGE),
    );
    expect(saveButton).toBeEnabled();
  });
});

// #1840: a real form means Enter in a single-line field saves once.
describe("AgentForm form submission", () => {
  beforeEach(() => {
    resetFormHarness();
    registerSwrData();
  });

  const stored = {
    id: "a1",
    name: "Old name",
    description: "A helpful bot",
    providerId: "p1",
    modelId: "gpt-4o",
    maxSteps: 5,
    toolSetIds: [],
    skillIds: [],
    subAgentIds: [],
  };

  const renderEditForm = () => {
    setDataFor("/agents/a1", stored);
    return render(
      <AgentForm
        orgId="org1"
        workspaceId="ws1"
        toolSets={[]}
        agents={[]}
        agentId="a1"
      />,
    );
  };

  it("saves on Enter in the Name field", async () => {
    const fetchMock = stubSaveSequence({ status: 200, body: { id: "a1" } });
    renderEditForm();

    const name = await screen.findByDisplayValue("Old name");
    fireEvent.change(name, { target: { value: "Bot" } });
    await setupUser().type(name, "{Enter}");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(
      expectSentBodyToMatchSchema(fetchMock, agentUpdateSchema),
    ).toMatchObject({ name: "Bot" });
  });

  it("sends a create body the strict Agent schema accepts", async () => {
    const fetchMock = stubSaveSequence({ status: 200, body: { id: "a1" } });
    renderCreateForm();

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Bot" },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "A test Agent" },
    });
    await selectOption(
      screen.getByRole("combobox", { name: "Model" }),
      "gpt-4o",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(
      expectSentBodyToMatchSchema(fetchMock, agentCreateSchema),
    ).toMatchObject({
      name: "Bot",
      description: "A test Agent",
      providerId: "p1",
      modelId: "gpt-4o",
    });
  });

  // The schema owns validation, so the browser's own step/type checks must not
  // block a save now that these fields live in a real form.
  it("does not let browser constraint validation block a schema-valid save", async () => {
    const fetchMock = stubSaveSequence({ status: 200, body: { id: "a1" } });
    renderEditForm();

    fireEvent.click(screen.getByText("Advanced settings"));
    fireEvent.change(screen.getByLabelText("Top-p"), {
      target: { value: "0.95" },
    });
    await setupUser().type(
      await screen.findByDisplayValue("Old name"),
      "Bot{Enter}",
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(
      expectSentBodyToMatchSchema(fetchMock, agentUpdateSchema),
    ).toMatchObject({ topP: 0.95 });
  });
});

// #1845: every save and delete toasts success, including those that navigate
// away; arriving on the list is not feedback enough.
describe("AgentForm success feedback", () => {
  beforeEach(() => {
    resetFormHarness();
    registerSwrData();
  });

  it("toasts that the Agent was created", async () => {
    stubAcceptedSave({ id: "a1" });

    renderCreateForm();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Bot" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Agent created"),
    );
    expect(push).toHaveBeenCalledWith("/org1/workspace/ws1");
  });

  it("toasts that the Agent was updated", async () => {
    setDataFor("/agents/a1", {
      id: "a1",
      name: "Bot",
      description: "",
      providerId: "p1",
      modelId: "gpt-4o",
      maxSteps: 5,
      toolSetIds: [],
      skillIds: [],
      subAgentIds: [],
    });
    stubAcceptedSave({ id: "a1" });

    render(
      <AgentForm
        orgId="org1"
        workspaceId="ws1"
        toolSets={[]}
        agents={[]}
        agentId="a1"
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Update" }));

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Agent updated"),
    );
    expect(push).toHaveBeenCalledWith("/org1/workspace/ws1");
  });

  it("toasts that the Agent was deleted", async () => {
    setDataFor("/agents/a1", {
      id: "a1",
      name: "Bot",
      description: "",
      providerId: "p1",
      modelId: "gpt-4o",
      maxSteps: 5,
      toolSetIds: [],
      skillIds: [],
      subAgentIds: [],
    });
    stubAcceptedSave({});

    render(
      <AgentForm
        orgId="org1"
        workspaceId="ws1"
        toolSets={[]}
        agents={[]}
        agentId="a1"
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /Delete/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Agent deleted"),
    );
    expect(push).toHaveBeenCalledWith("/org1/workspace/ws1");
  });
});

// #595: the Agent itself already saved by the time either avatar write runs,
// so a refused avatar write is a partial success — it must toast, not block
// navigation or silently look like it worked.
describe("AgentForm avatar write partial-success handling", () => {
  beforeEach(() => {
    resetFormHarness();
    registerSwrData();
    setDataFor("/agents/a1", undefined);
  });

  it("surfaces a toast but still navigates when the avatar upload fails after a successful agent save", async () => {
    const file = new File(["avatar-bytes"], "avatar.png", {
      type: "image/png",
    });
    const fetchMock = stubSaveSequence(
      { status: 200, body: { id: "a1" } },
      { status: 500, body: { error: "Storage unavailable" } },
    );

    const { container } = renderCreateForm();
    const fileInput = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(push).toHaveBeenCalledWith("/org1/workspace/ws1"),
    );
    expect(toastError).toHaveBeenCalledWith("Storage unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces a toast but still navigates when the avatar delete fails after a successful agent save", async () => {
    setDataFor("/agents/a1", {
      id: "a1",
      name: "Bot",
      description: "A helpful bot",
      instructions: "Be helpful",
      providerId: "p1",
      modelId: "gpt-4o",
      maxSteps: 5,
      avatarUrl: "http://cdn.test/avatar.png",
    });
    const fetchMock = stubSaveSequence(
      { status: 200, body: { id: "a1" } },
      { status: 403, body: { error: "Avatar storage locked" } },
    );

    render(
      <AgentForm
        orgId="org1"
        workspaceId="ws1"
        toolSets={[]}
        agents={[]}
        agentId="a1"
      />,
    );

    expect(await screen.findByDisplayValue("Bot")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Remove/i }));
    fireEvent.click(screen.getByRole("button", { name: "Update" }));

    await waitFor(() =>
      expect(push).toHaveBeenCalledWith("/org1/workspace/ws1"),
    );
    expect(toastError).toHaveBeenCalledWith("Avatar storage locked");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("AgentForm tool set load failure", () => {
  const toolSet = {
    id: "ts1",
    name: "Web Search",
    category: "Built-in",
  } as unknown as ToolSet;

  beforeEach(() => {
    resetFormHarness();
    registerSwrData();
    setDataFor("/agents/a1", undefined);
  });

  it("names authentication as the cause, and keeps the form usable, when the tool sets request was rejected as unauthorized", () => {
    render(
      <AgentForm
        orgId="org1"
        workspaceId="ws1"
        toolSets={[]}
        agents={[]}
        toolSetsError="unauthorized"
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/tools couldn't be loaded/i);
    expect(alert).toHaveTextContent(/sign(ed)? in|authenticat/i);
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("does not blame authentication when the tool sets request failed for another reason", () => {
    render(
      <AgentForm
        orgId="org1"
        workspaceId="ws1"
        toolSets={[]}
        agents={[]}
        toolSetsError="unavailable"
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/tools couldn't be loaded/i);
    expect(alert).not.toHaveTextContent(/authenticat/i);
  });

  it("shows no error and no Tools card when the workspace genuinely has no tool sets", () => {
    render(
      <AgentForm orgId="org1" workspaceId="ws1" toolSets={[]} agents={[]} />,
    );

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("Tools")).not.toBeInTheDocument();
  });

  it("renders the Tools card as usual when the tool sets loaded", () => {
    render(
      <AgentForm
        orgId="org1"
        workspaceId="ws1"
        toolSets={[toolSet]}
        agents={[]}
      />,
    );

    expect(screen.getByText("Tools")).toBeInTheDocument();
    expect(screen.getByText("Web Search")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("still groups tool sets by category, keeping Uncategorized last", () => {
    const uncategorised = {
      id: "ts2",
      name: "Loose Tool",
    } as unknown as ToolSet;
    const mcp = {
      id: "ts3",
      name: "Some MCP",
      category: "MCP",
    } as unknown as ToolSet;

    render(
      <AgentForm
        orgId="org1"
        workspaceId="ws1"
        toolSets={[uncategorised, mcp, toolSet]}
        agents={[]}
      />,
    );

    const headings = screen
      .getAllByText(/^(Built-in|MCP|Uncategorized)$/)
      .map((el) => el.textContent);
    expect(headings).toEqual(["Built-in", "MCP", "Uncategorized"]);
  });

  it("names the Organization, not a Workspace, on a Shared Agent", () => {
    render(
      <AgentForm
        orgId="org1"
        agentId="a1"
        toolSets={[]}
        agents={[]}
        toolSetsError="unauthorized"
        orgScoped
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/Organization/);
    expect(alert).not.toHaveTextContent(/Workspace/);
  });

  it("does not promise to preserve selections when creating a new Agent", () => {
    render(
      <AgentForm
        orgId="org1"
        workspaceId="ws1"
        toolSets={[]}
        agents={[]}
        toolSetsError="unauthorized"
      />,
    );

    expect(screen.getByRole("alert")).not.toHaveTextContent(
      /existing tool selections/i,
    );
  });

  it("preserves an existing agent's tool set selections when the tool sets could not be loaded", async () => {
    setDataFor("/agents/a1", {
      id: "a1",
      name: "Bot",
      description: "A helpful bot",
      instructions: "Be helpful",
      providerId: "p1",
      modelId: "gpt-4o",
      maxSteps: 5,
      toolSetIds: ["ts1", "ts2"],
    });
    const fetchMock = stubSaveSequence({ status: 200, body: { id: "a1" } });

    render(
      <AgentForm
        orgId="org1"
        workspaceId="ws1"
        toolSets={[]}
        agents={[]}
        agentId="a1"
        toolSetsError="unauthorized"
      />,
    );

    expect(await screen.findByDisplayValue("Bot")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Update" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = expectSentBodyToMatchSchema(fetchMock, agentUpdateSchema);
    expect(body.toolSetIds).toEqual(["ts1", "ts2"]);
  });
});

describe("AgentForm loading gate", () => {
  beforeEach(() => {
    resetFormHarness();
    registerSwrData();
  });

  it("holds the form back until the Skills list lands, so its card can't pop in", () => {
    setLoading("/skills");

    renderCreateForm();

    // A create page waits only on its lists, so it doesn't claim to be
    // loading an agent.
    expect(screen.getByLabelText("Loading form")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument();
  });

  it("holds the form back until the Sub-Agent candidates land", () => {
    setLoading("/agents");

    render(<AgentForm orgId="org1" workspaceId="ws1" toolSets={[]} />);

    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument();
  });

  it("doesn't wait on an agents read when the page hands the list in", () => {
    setLoading("/agents");

    renderCreateForm();

    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });
});

describe("AgentForm Skills search", () => {
  const skills = [
    { id: "s2", name: "Writing", description: "Write well" },
    { id: "s1", name: "Analysis", description: "Analyse data" },
    { id: "s3", name: "Research", description: "Find sources" },
  ];

  beforeEach(() => {
    resetFormHarness();
    registerSwrData();
    setDataFor("/skills", { results: skills });
  });

  const skillSwitchIds = () =>
    screen
      .queryAllByRole("switch")
      .filter((el) => el.id.startsWith("skill-"))
      .map((el) => el.id);

  it("renders the Skills alphabetically, with clamped descriptions", () => {
    renderCreateForm();

    expect(skillSwitchIds()).toEqual(["skill-s1", "skill-s3", "skill-s2"]);
    expect(screen.getByText("Write well")).toHaveClass("line-clamp-6");
  });

  it("narrows the switches by name, and restores them when cleared", () => {
    renderCreateForm();
    const search = screen.getByRole("searchbox", { name: "Search skills" });

    fireEvent.change(search, { target: { value: "writ" } });
    expect(skillSwitchIds()).toEqual(["skill-s2"]);

    fireEvent.change(search, { target: { value: "" } });
    expect(skillSwitchIds()).toEqual(["skill-s1", "skill-s3", "skill-s2"]);
  });

  it("says so when the search matches nothing", () => {
    renderCreateForm();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search skills" }), {
      target: { value: "zzzz" },
    });

    expect(skillSwitchIds()).toEqual([]);
    expect(
      screen.getByText("No skills match your search."),
    ).toBeInTheDocument();
  });

  it("renders no Skills card when the Workspace has no Skills", () => {
    setDataFor("/skills", { results: [] });
    renderCreateForm();

    expect(screen.queryByText("Skills")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("searchbox", { name: "Search skills" }),
    ).not.toBeInTheDocument();
  });

  it("does not save the Agent when Enter is pressed in the skill search", async () => {
    const fetchMock = stubSaveSequence({ status: 200, body: { id: "a1" } });
    renderCreateForm();

    const search = screen.getByRole("searchbox", { name: "Search skills" });
    fireEvent.change(search, { target: { value: "writ" } });
    await setupUser().type(search, "{Enter}");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a selected Skill in skillIds on Save after the search hides it", async () => {
    setDataFor("/agents/a1", {
      id: "a1",
      name: "Bot",
      description: "A helpful bot",
      instructions: "Be helpful",
      providerId: "p1",
      modelId: "gpt-4o",
      maxSteps: 5,
      skillIds: [],
    });
    const fetchMock = stubSaveSequence({ status: 200, body: { id: "a1" } });
    render(
      <AgentForm
        orgId="org1"
        workspaceId="ws1"
        toolSets={[]}
        agents={[]}
        agentId="a1"
      />,
    );
    expect(await screen.findByDisplayValue("Bot")).toBeInTheDocument();

    fireEvent.click(document.getElementById("skill-s2")!);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search skills" }), {
      target: { value: "analysis" },
    });
    expect(skillSwitchIds()).toEqual(["skill-s1"]);
    fireEvent.click(screen.getByRole("button", { name: "Update" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = expectSentBodyToMatchSchema(fetchMock, agentUpdateSchema);
    expect(body.skillIds).toEqual(["s2"]);
  });

  it("keeps the search usable on a read-only Shared Agent", async () => {
    setDataFor("/agents/a1", {
      id: "a1",
      name: "Bot",
      providerId: "p1",
      modelId: "gpt-4o",
      maxSteps: 5,
      scope: "organization",
      toolSetIds: [],
      skillIds: [],
      subAgentIds: [],
    });
    render(
      <AgentForm
        orgId="org1"
        workspaceId="ws1"
        toolSets={[]}
        agents={[]}
        agentId="a1"
      />,
    );
    expect(await screen.findByDisplayValue("Bot")).toBeInTheDocument();

    expect(
      screen.getByRole("searchbox", { name: "Search skills" }),
    ).toBeEnabled();
    expect(document.getElementById("skill-s1")).toBeDisabled();
  });
});

// Issue #1521: the Reasoning section follows the selected model's map.
describe("AgentForm Reasoning section", () => {
  const thinkingProvider = {
    ...provider,
    providerType: "OpenAI",
    apiMode: "chat",
    modelIds: [
      {
        id: "gpt-4o",
        passthroughFileTypes: [],
        reasoning: {
          thinking: { on: {}, off: {} },
          effort: { high: {} },
          budget: { field: "thinking_token_budget" },
        },
      },
    ],
  } as unknown as Provider;

  const stored = {
    id: "a1",
    name: "Bot",
    description: "A helpful bot",
    instructions: "",
    providerId: "p1",
    modelId: "gpt-4o",
    maxSteps: 5,
    reasoningThinking: true,
    reasoningEffort: "high",
    thinkingBudget: 2048,
  };

  const renderEdit = () =>
    render(
      <AgentForm
        orgId="org1"
        workspaceId="ws1"
        toolSets={[]}
        agents={[]}
        agentId="a1"
      />,
    );

  beforeEach(() => {
    resetFormHarness();
    registerSwrData();
  });

  it("is absent for a model with no map", async () => {
    setDataFor("/agents/a1", stored);
    renderEdit();

    expect(await screen.findByDisplayValue("Bot")).toBeInTheDocument();
    expect(screen.queryByText("Reasoning")).not.toBeInTheDocument();
  });

  // Issue #1689: a native model has no map, but still offers Thinking and
  // Effort; the budget needs a map.
  it("offers Thinking and Effort, but no budget, on a native model", async () => {
    setDataFor("/providers", {
      results: [{ ...provider, providerType: "Anthropic" }],
    });
    setDataFor("/agents/a1", stored);
    renderEdit();

    expect(await screen.findByLabelText("Thinking")).toBeInTheDocument();
    expect(screen.getByLabelText("Effort")).toBeInTheDocument();
    expect(screen.queryByLabelText("Thinking budget")).not.toBeInTheDocument();
  });

  it("round-trips all three fields, and a cleared one saves as null", async () => {
    setDataFor("/providers", { results: [thinkingProvider] });
    setDataFor("/agents/a1", stored);
    const fetchMock = stubSaveSequence(
      { status: 200, body: { id: "a1" } },
      { status: 200, body: { id: "a1" } },
    );
    renderEdit();

    expect(await screen.findByDisplayValue("2048")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(
      expectSentBodyToMatchSchema(fetchMock, agentUpdateSchema),
    ).toMatchObject({
      reasoningThinking: true,
      reasoningEffort: "high",
      thinkingBudget: 2048,
    });

    fireEvent.change(screen.getByLabelText("Thinking budget"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(
      expectSentBodyToMatchSchema(fetchMock, agentUpdateSchema),
    ).toMatchObject({
      thinkingBudget: null,
    });
  });
});

// Issue #1803 / ADR-0043: an Agent may carry a Fallback model.
describe("AgentForm Fallback model", () => {
  const fallbackProvider = {
    ...provider,
    id: "p2",
    name: "Anthropic",
    modelIds: [{ id: "claude-sonnet-4-5", passthroughFileTypes: [] }],
  } as unknown as Provider;

  const stored = {
    id: "a1",
    name: "Bot",
    description: "A helpful bot",
    instructions: "",
    providerId: "p1",
    modelId: "gpt-4o",
    fallbackProviderId: "p2",
    fallbackModelId: "claude-sonnet-4-5",
    maxSteps: 5,
  };

  const renderEdit = () =>
    render(
      <AgentForm
        orgId="org1"
        workspaceId="ws1"
        toolSets={[]}
        agents={[]}
        agentId="a1"
      />,
    );

  beforeEach(() => {
    resetFormHarness();
    registerSwrData();
    setDataFor("/providers", { results: [provider, fallbackProvider] });
  });

  it("shows the field with the Agent's stored fallback and saves it", async () => {
    setDataFor("/agents/a1", stored);
    const fetchMock = stubSaveSequence({ status: 200, body: { id: "a1" } });
    renderEdit();

    expect(await screen.findByText("Fallback model")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Used by Trigger runs when this Agent's primary Provider is unavailable. Chat turns never switch models.",
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(
      expectSentBodyToMatchSchema(fetchMock, agentUpdateSchema),
    ).toMatchObject({
      fallbackProviderId: "p2",
      fallbackModelId: "claude-sonnet-4-5",
    });
  });

  it("saves an Agent with no fallback as null", async () => {
    setDataFor("/agents/a1", {
      ...stored,
      fallbackProviderId: null,
      fallbackModelId: null,
    });
    const fetchMock = stubSaveSequence({ status: 200, body: { id: "a1" } });
    renderEdit();

    expect(await screen.findByText("Fallback model")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(
      expectSentBodyToMatchSchema(fetchMock, agentUpdateSchema),
    ).toMatchObject({
      fallbackProviderId: null,
      fallbackModelId: null,
    });
  });

  it("clears both fallback fields when None is picked", async () => {
    setDataFor("/agents/a1", stored);
    const fetchMock = stubSaveSequence({ status: 200, body: { id: "a1" } });
    renderEdit();

    expect(await screen.findByText("Fallback model")).toBeInTheDocument();
    await selectOption(
      screen.getByRole("combobox", { name: "Fallback model" }),
      "None",
    );
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(
      expectSentBodyToMatchSchema(fetchMock, agentUpdateSchema),
    ).toMatchObject({
      fallbackProviderId: null,
      fallbackModelId: null,
    });
  });

  it.each([
    ["fallbackProviderId", "Provider unavailable"],
    ["fallbackModelId", "Model is required"],
  ])(
    "shows an error keyed to %s on the one control",
    async (field, message) => {
      setDataFor("/agents/a1", stored);
      stubRejectedSave([{ path: [field], message }]);
      renderEdit();

      fireEvent.click(await screen.findByRole("button", { name: "Update" }));

      expect(await screen.findByText(message)).toBeInTheDocument();
      expect(
        screen.getByRole("combobox", { name: "Fallback model" }),
      ).toHaveAttribute("aria-invalid", "true");
    },
  );
});
