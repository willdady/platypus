import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Agent } from "@platypus/schemas";
import {
  installRadixPointerPolyfills,
  openDropdownMenu as openMenu,
} from "@/lib/test-utils";

beforeAll(installRadixPointerPolyfills);

// --- Module mocks ------------------------------------------------------------

vi.mock("@/app/client-context", () => ({
  useBackendUrl: () => "http://test",
}));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({
    user: { id: "u1" },
    isOrgAdmin: true,
  }),
}));

// The `GET .../agents` list this component renders. Set per test.
let agents: Agent[] = [];
const mutateSpy = vi.fn();

vi.mock("swr", () => ({
  __esModule: true,
  default: () => ({
    data: { results: agents },
    isLoading: false,
    mutate: mutateSpy,
  }),
}));

import { OrgAgentsList } from "./org-agents-list";

// --- Helpers -----------------------------------------------------------------

const sharedAgent: Agent = {
  id: "a1",
  name: "Shared Agent",
  description: "desc",
} as unknown as Agent;

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  agents = [];
  mutateSpy.mockClear();
  vi.restoreAllMocks();
});

// --- Tests -------------------------------------------------------------------

describe("OrgAgentsList delete", () => {
  it("blocks delete and reports the attachment count when the agent is still attached", async () => {
    agents = [sharedAgent];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { results: [{ id: "att1" }] }));
    vi.stubGlobal("fetch", fetchMock);

    render(<OrgAgentsList orgId="org1" />);
    openMenu();
    fireEvent.click(screen.getByText("Delete"));

    await waitFor(() =>
      expect(screen.getByText("Can't delete shared agent")).toBeInTheDocument(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/attachments?resourceType=agent&resourceId=a1",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("surfaces the backend's reason and keeps the agent when delete fails", async () => {
    agents = [sharedAgent];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { results: [] }))
      .mockResolvedValueOnce(jsonResponse(409, { error: "Still referenced" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<OrgAgentsList orgId="org1" />);
    openMenu();
    fireEvent.click(screen.getByText("Delete"));

    const deleteButton = await screen.findByRole("button", { name: "Delete" });
    fireEvent.click(deleteButton);

    await waitFor(() =>
      expect(screen.getByText("Still referenced")).toBeInTheDocument(),
    );
    expect(mutateSpy).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/agents/a1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("revalidates when delete succeeds", async () => {
    agents = [sharedAgent];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { results: [] }))
      .mockResolvedValueOnce(jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    render(<OrgAgentsList orgId="org1" />);
    openMenu();
    fireEvent.click(screen.getByText("Delete"));

    const deleteButton = await screen.findByRole("button", { name: "Delete" });
    fireEvent.click(deleteButton);

    await waitFor(() => expect(mutateSpy).toHaveBeenCalled());
  });
});
