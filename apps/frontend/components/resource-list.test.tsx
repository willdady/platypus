import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import type { MCP, Provider } from "@platypus/schemas";
import type { WorkspaceDelegationFlags } from "@/lib/authorization";
import {
  authMock,
  authState,
  swrMock,
  mockScopedSWR,
  resetListHarness,
  renderList,
  stubAcceptedSave,
  stubRejectedSave,
  mutate,
} from "@/lib/list-test-harness";

// --- Module mocks ------------------------------------------------------------

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("swr", () => swrMock);

import { ProvidersList } from "./providers-list";
import { McpList } from "./mcp-list";

type ScopedResource = (Provider | MCP) & {
  scope?: "organization" | "workspace";
};

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
  /** Collection entity as the API spells it — the read the list makes. */
  entity: string;
  settingsPath: string;
  /** The Workspace delegation flag letting its Owner self-manage the resource. */
  delegationFlag: keyof WorkspaceDelegationFlags;
  item: ScopedResource;
  workspaceItem: ScopedResource;
  dialogTitle: string;
  fetchErrorNoun: string;
}[] = [
  {
    name: "provider",
    List: ProvidersList,
    resourceType: "provider",
    entity: "providers",
    settingsPath: "settings/providers",
    delegationFlag: "providerSelfManagement",
    item: orgProvider,
    workspaceItem: workspaceProvider,
    dialogTitle: "Organization Provider",
    fetchErrorNoun: "providers",
  },
  {
    name: "MCP",
    List: McpList,
    resourceType: "mcp",
    entity: "mcps",
    settingsPath: "settings/mcp",
    delegationFlag: "mcpSelfManagement",
    item: orgMcp,
    workspaceItem: workspaceMcp,
    dialogTitle: "Organization MCP",
    fetchErrorNoun: "MCP servers",
  },
];

beforeEach(resetListHarness);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- Tests -------------------------------------------------------------------

describe.each(RESOURCES)(
  "$name list",
  ({
    List,
    resourceType,
    entity,
    settingsPath,
    delegationFlag,
    item,
    workspaceItem,
    dialogTitle,
    fetchErrorNoun,
  }) => {
    /** Renders the Workspace surface with `rows` in the list. */
    const renderRows = (rows: ScopedResource[]) => {
      mockScopedSWR({ [`/${entity}`]: rows });
      return renderList(<List orgId="org1" workspaceId="ws1" />);
    };

    it("links each workspace row to its workspace settings page", () => {
      renderRows([workspaceItem]);

      expect(screen.getByText(workspaceItem.name).closest("a")).toHaveAttribute(
        "href",
        `/org1/workspace/ws1/${settingsPath}/${workspaceItem.id}`,
      );
    });

    it("links the create CTA to the workspace create page", () => {
      renderRows([item]);

      expect(screen.getByRole("link", { name: /^Add/ })).toHaveAttribute(
        "href",
        `/org1/workspace/ws1/${settingsPath}/create`,
      );
    });

    it("offers a delegated Workspace Owner the create page when the workspace has none", () => {
      authState.actor = "workspace-owner";
      authState.workspaceDelegation = { [delegationFlag]: true };
      renderRows([]);

      expect(screen.queryByText(/configured/)).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: /^Add/ })).toHaveAttribute(
        "href",
        `/org1/workspace/ws1/${settingsPath}/create`,
      );
    });

    it("offers a non-delegated Workspace Owner no create CTA when the workspace has none", () => {
      authState.actor = "workspace-owner";
      authState.workspaceDelegation = { [delegationFlag]: false };
      renderRows([]);

      expect(
        screen.getByText(/Ask an organization admin to add one/),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("link", { name: /^Add/ }),
      ).not.toBeInTheDocument();
    });

    it("offers an Org Admin both create and attach when the workspace has none", () => {
      authState.actor = "org-admin";
      renderRows([]);

      expect(screen.getByRole("link", { name: /^Add/ })).toHaveAttribute(
        "href",
        `/org1/workspace/ws1/${settingsPath}/create`,
      );
      expect(
        screen.getByRole("button", { name: /^Attach shared/ }),
      ).toBeInTheDocument();
    });

    it("renders a fetch failure rather than swallowing it", () => {
      mockScopedSWR({
        [`/${entity}`]: {
          error: {
            message: "An error occurred while fetching the data.",
            info: { message: "Server exploded" },
          },
        },
      });
      renderList(<List orgId="org1" workspaceId="ws1" />);

      expect(
        screen.getByText(`Failed to load ${fetchErrorNoun}. Server exploded`),
      ).toBeInTheDocument();
    });

    it("points the detach dialog's Org settings link at the organization page", () => {
      renderRows([item]);
      fireEvent.click(screen.getByText(item.name));

      expect(
        screen.getByRole("link", { name: /Org settings/ }),
      ).toHaveAttribute("href", `/org1/${settingsPath}/${item.id}`);
    });

    it("detaches through the request module and revalidates on success", async () => {
      const fetchMock = stubAcceptedSave();

      renderRows([item]);
      fireEvent.click(screen.getByText(item.name));
      fireEvent.click(screen.getByRole("button", { name: /Detach/ }));

      await waitFor(() => expect(mutate).toHaveBeenCalled());
      expect(fetchMock).toHaveBeenCalledWith(
        `http://test/organizations/org1/workspaces/ws1/attachments/${resourceType}/${item.id}`,
        expect.objectContaining({ method: "DELETE" }),
      );
      expect(screen.queryByText(dialogTitle)).not.toBeInTheDocument();
    });

    it("surfaces the backend's reason and keeps the dialog open when detach is refused", async () => {
      stubRejectedSave(
        "This resource is in use by an agent in this workspace",
        409,
      );

      renderRows([item]);
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
      expect(mutate).not.toHaveBeenCalled();
      // The dialog stays open rather than silently closing.
      expect(screen.getByText(dialogTitle)).toBeInTheDocument();
    });
  },
);
