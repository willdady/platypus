import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { installRadixPointerPolyfills } from "@/lib/test-utils";

// The Command palette (cmdk) needs a ResizeObserver and scrollIntoView, which
// jsdom lacks.
beforeAll(() => {
  installRadixPointerPolyfills();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

// --- Module mocks ------------------------------------------------------------

vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://test",
  useAuth: () => ({ user: { id: "u1" } }),
}));

// The attachments and workspaces lists this component renders. Set per test.
let attached: { workspaceId: string; workspaceName: string }[] = [];
let workspaces: { id: string; name: string }[] = [];
const mutateAttSpy = vi.fn();

vi.mock("swr", () => ({
  __esModule: true,
  default: (key: string | null) => {
    if (typeof key === "string" && key.includes("/attachments?")) {
      return { data: { results: attached }, mutate: mutateAttSpy };
    }
    if (typeof key === "string" && key.endsWith("/workspaces")) {
      return { data: { results: workspaces } };
    }
    return { data: undefined };
  },
}));

import { ManageAttachmentsDialog } from "./manage-sharing";

// --- Helpers -----------------------------------------------------------------

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  attached = [];
  workspaces = [];
  mutateAttSpy.mockClear();
  vi.restoreAllMocks();
});

// --- Tests -------------------------------------------------------------------

describe("ManageAttachmentsDialog attach", () => {
  it("POSTs the attachment and revalidates on success", async () => {
    workspaces = [{ id: "ws1", name: "Engineering" }];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ManageAttachmentsDialog
        orgId="org1"
        resourceType="agent"
        resourceId="a1"
        resourceName="Support Bot"
        open={true}
        onOpenChange={() => {}}
      />,
    );

    fireEvent.click(screen.getByText("Engineering"));

    await waitFor(() => expect(mutateAttSpy).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/attachments",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          resourceType: "agent",
          resourceId: "a1",
          workspaceId: "ws1",
        }),
      }),
    );
  });

  it("surfaces the backend's reason inline and does not revalidate when attach is refused", async () => {
    workspaces = [{ id: "ws1", name: "Engineering" }];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(409, { error: "Already attached" }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ManageAttachmentsDialog
        orgId="org1"
        resourceType="agent"
        resourceId="a1"
        resourceName="Support Bot"
        open={true}
        onOpenChange={() => {}}
      />,
    );

    fireEvent.click(screen.getByText("Engineering"));

    await waitFor(() =>
      expect(screen.getByText("Already attached")).toBeInTheDocument(),
    );
    expect(mutateAttSpy).not.toHaveBeenCalled();
  });
});

describe("ManageAttachmentsDialog detach", () => {
  it("surfaces the backend's reason inline and does not revalidate when detach is refused", async () => {
    attached = [{ workspaceId: "ws1", workspaceName: "Engineering" }];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(403, { error: "Locked elsewhere" }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ManageAttachmentsDialog
        orgId="org1"
        resourceType="agent"
        resourceId="a1"
        resourceName="Support Bot"
        open={true}
        onOpenChange={() => {}}
      />,
    );

    fireEvent.click(screen.getByLabelText("Detach Engineering"));

    await waitFor(() =>
      expect(screen.getByText("Locked elsewhere")).toBeInTheDocument(),
    );
    expect(mutateAttSpy).not.toHaveBeenCalled();
    // The chip stays — no optimistic removal on a refused detach.
    expect(screen.getByText("Engineering")).toBeInTheDocument();
  });
});
