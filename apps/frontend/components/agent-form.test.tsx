import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: vi.fn(),
  },
}));

const mutate = vi.fn();
const provider: Provider = {
  id: "p1",
  name: "OpenAI",
  modelIds: [{ id: "gpt-4o", passthroughFileTypes: [] }],
} as unknown as Provider;

// Stable references so re-renders don't churn identity (which would retrigger
// useResetOnChange and loop).
const providersResponse = { data: { results: [provider] }, isLoading: false };
const emptyListResponse = { data: { results: [] }, isLoading: false };
const nullResponse = { data: undefined, isLoading: false };

// useSWR is called for providers, skills, agents, and (when editing) the agent.
// Key off the request URL so each call gets the right payload. A null key means
// SWR would not fetch — mirror that by returning no data.
vi.mock("swr", () => ({
  __esModule: true,
  default: (key: string | null) => {
    if (!key) return nullResponse;
    if (typeof key === "string" && key.endsWith("/providers")) {
      return providersResponse;
    }
    return emptyListResponse;
  },
  useSWRConfig: () => ({ mutate }),
}));

import { AgentForm } from "./agent-form";

// --- Helpers -----------------------------------------------------------------

function mockFailedSave(error: unknown) {
  return vi.fn().mockResolvedValue({
    ok: false,
    json: async () => ({ error }),
  } as unknown as Response);
}

function renderCreateForm() {
  return render(
    <AgentForm orgId="org1" workspaceId="ws1" toolSets={[]} agents={[]} />,
  );
}

// --- Tests -------------------------------------------------------------------

describe("AgentForm validation error surfacing", () => {
  beforeEach(() => {
    push.mockReset();
    toastError.mockReset();
    mutate.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders an inline error and marks the Model control invalid when the server rejects modelId", async () => {
    vi.stubGlobal(
      "fetch",
      mockFailedSave([{ path: ["modelId"], message: "Model is required" }]),
    );

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
    vi.stubGlobal(
      "fetch",
      mockFailedSave("something went wrong on the server"),
    );

    renderCreateForm();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Failed to save agent"),
    );
  });

  it("clears a field's error and re-enables Save once the field is edited", async () => {
    vi.stubGlobal(
      "fetch",
      mockFailedSave([{ path: ["maxSteps"], message: "Invalid max steps" }]),
    );

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
});
