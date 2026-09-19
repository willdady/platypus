import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import type { MCP, Provider } from "@platypus/schemas";

// --- Module mocks ------------------------------------------------------------

vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://test",
  useAuth: () => ({
    user: { id: "u1" },
    actor: "org-admin",
    workspaceDelegation: null,
  }),
}));

type ScopedResource = (Provider | MCP) & {
  scope?: "organization" | "workspace";
};

// The list this component renders, and the failure it may fail with. Set per test.
let items: ScopedResource[] = [];
let listError: unknown = undefined;
const mutateSpy = vi.fn();

vi.mock("swr", () => ({
  __esModule: true,
  default: () => ({
    data: { results: items },
    error: listError,
    isLoading: false,
    mutate: mutateSpy,
  }),
}));

import { ProvidersList } from "./providers-list";
import { McpList } from "./mcp-list";

// --- Fixtures ----------------------------------------------------------------

const orgProvider = {
  id: "p1",
  name: "Shared OpenAI",
  providerType: "OpenAI",
  scope: "organization",
} as unknown as ScopedResource;

const orgMcp = {
  id: "m1",
  name: "Shared MCP",
  scope: "organization",
} as unknown as ScopedResource;

const workspaceProvider = {
  id: "p2",
  name: "Local OpenAI",
  providerType: "OpenAI",
  scope: "workspace",
} as unknown as ScopedResource;

const workspaceMcp = {
  id: "m2",
  name: "Local MCP",
  scope: "workspace",
} as unknown as ScopedResource;

const RESOURCES: {
  name: string;
  List: ComponentType<{ orgId: string; workspaceId?: string }>;
  resourceType: "provider" | "mcp";
  settingsPath: string;
  item: ScopedResource;
  workspaceItem: ScopedResource;
  dialogTitle: string;
  fetchErrorNoun: string;
}[] = [
  {
    name: "provider",
    List: ProvidersList,
    resourceType: "provider",
    settingsPath: "settings/providers",
    item: orgProvider,
    workspaceItem: workspaceProvider,
    dialogTitle: "Organization Provider",
    fetchErrorNoun: "providers",
  },
  {
    name: "MCP",
    List: McpList,
    resourceType: "mcp",
    settingsPath: "settings/mcp",
    item: orgMcp,
    workspaceItem: workspaceMcp,
    dialogTitle: "Organization MCP",
    fetchErrorNoun: "MCP servers",
  },
];

// --- Helpers -----------------------------------------------------------------

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  items = [];
  listError = undefined;
  mutateSpy.mockClear();
  vi.restoreAllMocks();
});

// --- Tests -------------------------------------------------------------------

describe.each(RESOURCES)(
  "$name list",
  ({
    List,
    resourceType,
    settingsPath,
    item,
    workspaceItem,
    dialogTitle,
    fetchErrorNoun,
  }) => {
    it("links each workspace row to its workspace settings page", () => {
      items = [workspaceItem];

      render(<List orgId="org1" workspaceId="ws1" />);

      expect(screen.getByText(workspaceItem.name).closest("a")).toHaveAttribute(
        "href",
        `/org1/workspace/ws1/${settingsPath}/${workspaceItem.id}`,
      );
    });

    it("links the create CTA to the workspace create page", () => {
      items = [item];

      render(<List orgId="org1" workspaceId="ws1" />);

      expect(screen.getByRole("link", { name: /^Add/ })).toHaveAttribute(
        "href",
        `/org1/workspace/ws1/${settingsPath}/create`,
      );
    });

    it("renders a fetch failure rather than swallowing it", () => {
      listError = {
        message: "An error occurred while fetching the data.",
        info: { message: "Server exploded" },
      };

      render(<List orgId="org1" workspaceId="ws1" />);

      expect(
        screen.getByText(`Failed to load ${fetchErrorNoun}. Server exploded`),
      ).toBeInTheDocument();
    });

    it("points the detach dialog's Org settings link at the organization page", () => {
      items = [item];

      render(<List orgId="org1" workspaceId="ws1" />);
      fireEvent.click(screen.getByText(item.name));

      expect(
        screen.getByRole("link", { name: /Org settings/ }),
      ).toHaveAttribute("href", `/org1/${settingsPath}/${item.id}`);
    });

    it("detaches through the request module and revalidates on success", async () => {
      items = [item];
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
      vi.stubGlobal("fetch", fetchMock);

      render(<List orgId="org1" workspaceId="ws1" />);
      fireEvent.click(screen.getByText(item.name));
      fireEvent.click(screen.getByRole("button", { name: /Detach/ }));

      await waitFor(() => expect(mutateSpy).toHaveBeenCalled());
      expect(fetchMock).toHaveBeenCalledWith(
        `http://test/organizations/org1/workspaces/ws1/attachments/${resourceType}/${item.id}`,
        expect.objectContaining({ method: "DELETE" }),
      );
      expect(screen.queryByText(dialogTitle)).not.toBeInTheDocument();
    });

    it("surfaces the backend's reason and keeps the dialog open when detach is refused", async () => {
      items = [item];
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse(409, {
          error: "This resource is in use by an agent in this workspace",
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      render(<List orgId="org1" workspaceId="ws1" />);
      fireEvent.click(screen.getByText(item.name));
      fireEvent.click(screen.getByRole("button", { name: /Detach/ }));

      await waitFor(() =>
        expect(
          screen.getByText(
            "This resource is in use by an agent in this workspace",
          ),
        ).toBeInTheDocument(),
      );

      // A refused detach must not revalidate the list.
      expect(mutateSpy).not.toHaveBeenCalled();
      // The dialog stays open rather than silently closing.
      expect(screen.getByText(dialogTitle)).toBeInTheDocument();
    });
  },
);
