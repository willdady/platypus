import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  stubAcceptedSave,
  stubRejectedSave,
  toastError,
  toastMock,
  toastSuccess,
} from "@/lib/test-utils";

// --- Module mocks ------------------------------------------------------------

vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://test",
  useAuth: () => ({ user: { id: "u1" } }),
}));

vi.mock("sonner", () => toastMock);

vi.mock("@/components/contexts-list", () => ({
  ContextsList: () => null,
}));

// Defaults to a *warm* SWR cache: the fetched global context is already
// present on the very first render, as happens when navigating back from the
// Edit Workspace Context screen (which subscribes to the same SWR key).
const WARM = {
  data: {
    results: [
      { id: "ctx1", workspaceId: null, content: "saved global context" },
    ],
  },
  isLoading: false,
  error: undefined as unknown,
};
const swrState = vi.hoisted(() => ({
  response: {} as { data?: unknown; isLoading: boolean; error?: unknown },
}));
const mutate = vi.fn();

vi.mock("swr", () => ({
  useSWRConfig: () => ({ cache: new Map() }),
  __esModule: true,
  default: () => ({ ...swrState.response, mutate }),
}));

import ContextsPage from "./page";

// --- Tests -------------------------------------------------------------------

describe("ContextsPage global context field", () => {
  beforeEach(() => {
    swrState.response = WARM;
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows the saved global context immediately when SWR data is already warm on mount", () => {
    render(<ContextsPage />);

    expect(
      screen.getByDisplayValue("saved global context"),
    ).toBeInTheDocument();
  });

  it("hides the editor and disables Save until the read lands", () => {
    swrState.response = { data: undefined, isLoading: true };
    render(<ContextsPage />);

    expect(screen.getByLabelText("Loading global context")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("shows the failure and keeps Save disabled when the read fails cold", () => {
    swrState.response = {
      data: undefined,
      isLoading: false,
      error: { message: "Boom" },
    };
    render(<ContextsPage />);

    expect(
      screen.getByText("Failed to load global context. Boom"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});

describe("ContextsPage saving the global context", () => {
  const NONE = { ...WARM, data: { results: [] } };

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  const save = (content: string) => {
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: content },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
  };

  it("updates the existing global context in place", async () => {
    swrState.response = WARM;
    const fetchMock = stubAcceptedSave();
    render(<ContextsPage />);

    save("updated");

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Global context saved"),
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://test/users/me/contexts/ctx1");
    expect(init).toMatchObject({ method: "PUT" });
    expect(JSON.parse(init.body)).toEqual({ content: "updated" });
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("creates the global context when there is none yet", async () => {
    swrState.response = NONE;
    const fetchMock = stubAcceptedSave();
    render(<ContextsPage />);

    save("first");

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Global context saved"),
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://test/users/me/contexts");
    expect(init).toMatchObject({ method: "POST" });
    expect(JSON.parse(init.body)).toEqual({ content: "first" });
  });

  it.each([
    [
      "a create refused because one already exists",
      NONE,
      409,
      "You already have a global context",
    ],
    ["a failed create", NONE, 500, "Failed to create context"],
    ["a failed update", WARM, 409, "Failed to update context"],
  ])("reports %s", async (_name, response, status, message) => {
    swrState.response = response;
    stubRejectedSave("Nope", status);
    render(<ContextsPage />);

    save("text");

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(message));
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });
});
