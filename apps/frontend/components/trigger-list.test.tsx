import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Trigger } from "@platypus/schemas";
import {
  installRadixPointerPolyfills,
  openDropdownMenu as openMenu,
} from "@/lib/test-utils";

beforeAll(installRadixPointerPolyfills);

// --- Module mocks ------------------------------------------------------------

vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://test",
  useAuth: () => ({ user: { id: "u1" } }),
}));

const { toastErrorSpy } = vi.hoisted(() => ({ toastErrorSpy: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { error: toastErrorSpy },
}));

// The `GET .../triggers` list this component renders. Set per test.
let triggers: Trigger[] = [];
const mutateSpy = vi.fn();

vi.mock("swr", () => ({
  __esModule: true,
  default: (key: string | null) => {
    if (key?.includes("/triggers")) {
      return {
        data: { results: triggers },
        isLoading: false,
        mutate: mutateSpy,
      };
    }
    return { data: { results: [] }, isLoading: false };
  },
}));

import { TriggerList } from "./trigger-list";

// --- Helpers -----------------------------------------------------------------

const cronTrigger: Trigger = {
  id: "t1",
  name: "Nightly job",
  type: "cron",
  enabled: true,
  agentId: "agent1",
  config: { cronExpression: "0 0 * * *", timezone: "UTC" },
} as unknown as Trigger;

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  triggers = [];
  mutateSpy.mockClear();
  toastErrorSpy.mockClear();
  vi.restoreAllMocks();
});

// --- Tests -------------------------------------------------------------------

describe("TriggerList delete", () => {
  it("deletes through the request module and revalidates on success", async () => {
    triggers = [cronTrigger];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    render(<TriggerList orgId="org1" workspaceId="ws1" />);
    openMenu();
    fireEvent.click(screen.getByText("Delete"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(mutateSpy).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/triggers/t1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("surfaces the backend's reason inline and does not revalidate when delete is refused", async () => {
    triggers = [cronTrigger];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(409, { error: "Trigger is in use" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<TriggerList orgId="org1" workspaceId="ws1" />);
    openMenu();
    fireEvent.click(screen.getByText("Delete"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(screen.getByText("Trigger is in use")).toBeInTheDocument(),
    );
    expect(mutateSpy).not.toHaveBeenCalled();
    // The dialog stays open on a refused delete, letting the user retry.
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });
});

describe("TriggerList toggle enabled", () => {
  it("PUTs the flipped enabled flag and revalidates on success", async () => {
    triggers = [cronTrigger];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    render(<TriggerList orgId="org1" workspaceId="ws1" />);
    openMenu();
    fireEvent.click(screen.getByText("Disable"));

    await waitFor(() => expect(mutateSpy).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/triggers/t1",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ enabled: false }),
      }),
    );
  });

  it("surfaces the backend's reason and does not flip when the toggle is refused", async () => {
    triggers = [cronTrigger];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(409, { error: "Trigger is running" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<TriggerList orgId="org1" workspaceId="ws1" />);
    openMenu();
    fireEvent.click(screen.getByText("Disable"));

    await waitFor(() =>
      expect(toastErrorSpy).toHaveBeenCalledWith("Trigger is running"),
    );
    expect(mutateSpy).not.toHaveBeenCalled();
  });
});
