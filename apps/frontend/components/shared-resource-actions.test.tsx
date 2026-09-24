import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// --- Module mocks ------------------------------------------------------------

vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://test",
  useAuth: () => ({ user: { id: "u1" }, actor: "org-admin" }),
}));

// The organization's rows the picker offers. Set per test.
let orgRows: { id: string; name: string }[] = [];

vi.mock("swr", () => ({
  useSWRConfig: () => ({ cache: new Map() }),
  __esModule: true,
  default: () => ({ data: { results: orgRows }, isLoading: false }),
}));

import { AttachSharedAction } from "./shared-resource-actions";
import { jsonResponse } from "@/lib/test-utils";

afterEach(() => {
  orgRows = [];
  vi.restoreAllMocks();
});

// --- Tests -------------------------------------------------------------------

describe.each([
  { resourceType: "skill" as const, label: "Attach shared skill" },
  { resourceType: "provider" as const, label: "Attach shared provider" },
])("AttachSharedAction ($resourceType)", ({ resourceType, label }) => {
  it("offers only the organization rows this workspace has not attached", () => {
    orgRows = [
      { id: "r1", name: "Already Here" },
      { id: "r2", name: "Available" },
    ];

    render(
      <AttachSharedAction
        orgId="org1"
        workspaceId="ws1"
        resourceType={resourceType}
        label={label}
        resources={[{ id: "r1", scope: "organization" }]}
        onAttached={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: label }));

    expect(screen.getByText("Available")).toBeInTheDocument();
    expect(screen.queryByText("Already Here")).not.toBeInTheDocument();
  });

  it("attaches the chosen row and tells the list to revalidate", async () => {
    orgRows = [{ id: "r2", name: "Available" }];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, {}));
    vi.stubGlobal("fetch", fetchMock);
    const onAttached = vi.fn();

    render(
      <AttachSharedAction
        orgId="org1"
        workspaceId="ws1"
        resourceType={resourceType}
        label={label}
        resources={[]}
        onAttached={onAttached}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: label }));
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));

    await waitFor(() => expect(onAttached).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/attachments",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ resourceType, resourceId: "r2" }),
      }),
    );
  });

  it("surfaces the backend's reason when the attach is refused", async () => {
    orgRows = [{ id: "r2", name: "Available" }];
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(jsonResponse(409, { error: "Already attached" })),
    );
    const onAttached = vi.fn();

    render(
      <AttachSharedAction
        orgId="org1"
        workspaceId="ws1"
        resourceType={resourceType}
        label={label}
        resources={[]}
        onAttached={onAttached}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: label }));
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));

    await waitFor(() =>
      expect(screen.getByText("Already attached")).toBeInTheDocument(),
    );
    expect(onAttached).not.toHaveBeenCalled();
  });
});
