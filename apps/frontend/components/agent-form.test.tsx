import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Provider } from "@platypus/schemas";
import {
  navigationMock,
  configMock,
  authMock,
  toastMock,
  swrMock,
  push,
  toastError,
  setData,
  setDataFor,
  resetFormHarness,
  stubRejectedSave,
  stubSaveSequence,
} from "@/lib/form-test-harness";

// --- Module mocks ------------------------------------------------------------

vi.mock("next/navigation", () => navigationMock);
vi.mock("@/app/client-context", () => configMock);
vi.mock("@/components/auth-provider", () => authMock);
vi.mock("sonner", () => toastMock);
// useSWR is called for providers, skills, agents, and (when editing) the
// agent. The harness keys its responses off the request URL suffix, so
// each call gets the right payload; a key with no matcher (skills, the
// agents list) falls back to the default set below.
vi.mock("swr", () => swrMock);

import { AgentForm } from "./agent-form";

// --- Helpers -----------------------------------------------------------------

const provider: Provider = {
  id: "p1",
  name: "OpenAI",
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders an inline error and marks the Model control invalid when the server rejects modelId", async () => {
    stubRejectedSave([{ path: ["modelId"], message: "Model is required" }]);

    renderCreateForm();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(screen.getByText("Model is required")).toBeInTheDocument(),
    );

    // The Model select trigger is marked invalid for assistive tech.
    const trigger = screen.getByRole("combobox");
    expect(trigger).toHaveAttribute("aria-invalid", "true");

    // A validation failure is never silent.
    expect(toastError).toHaveBeenCalled();
  });

  it("shows a generic error toast when the failure maps to no inline field", async () => {
    stubRejectedSave("something went wrong on the server");

    renderCreateForm();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Failed to save agent"),
    );
  });

  it("clears a field's error and re-enables Save once the field is edited", async () => {
    stubRejectedSave([{ path: ["maxSteps"], message: "Invalid max steps" }]);

    renderCreateForm();

    const saveButton = screen.getByRole("button", { name: "Save" });
    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(screen.getByText("Invalid max steps")).toBeInTheDocument(),
    );
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
    expect(saveButton).not.toBeDisabled();
  });

  // #571: toolSetIds has no field that retracts its error, so gating Save on
  // it would disable Save forever with no way out but reloading.
  it("never disables Save on a rejection keyed to a field with no retracting input", async () => {
    stubRejectedSave([{ path: ["toolSetIds"], message: "Unknown tool set" }]);

    renderCreateForm();

    const saveButton = screen.getByRole("button", { name: "Save" });
    fireEvent.click(saveButton);

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(saveButton).not.toBeDisabled();
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

  afterEach(() => {
    vi.restoreAllMocks();
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

    await waitFor(() =>
      expect(screen.getByDisplayValue("Bot")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Remove/i }));
    fireEvent.click(screen.getByRole("button", { name: "Update" }));

    await waitFor(() =>
      expect(push).toHaveBeenCalledWith("/org1/workspace/ws1"),
    );
    expect(toastError).toHaveBeenCalledWith("Avatar storage locked");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
