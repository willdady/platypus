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
  stubSaveSequence,
  mutate,
  menuItemLabels,
  confirmDialog,
} from "@/test/list-test-harness";
import { openDropdownMenu } from "@/test/test-utils";

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
  url: "https://shared.example.com/mcp",
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
  url: "https://local.example.com/mcp",
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
  /** What the card's second line shows for `workspaceItem`. */
  secondLine: string;
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
    dialogTitle: "Detach shared provider",
    fetchErrorNoun: "providers",
    secondLine: "OpenAI",
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
    dialogTitle: "Detach shared MCP server",
    fetchErrorNoun: "MCP servers",
    secondLine: "https://local.example.com/mcp",
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
    secondLine,
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

      expect(screen.getByText(/^No .* configured$/)).toBeInTheDocument();
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

      expect(screen.getByText(/^No .* configured$/)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /^Add/ })).toHaveAttribute(
        "href",
        `/org1/workspace/ws1/${settingsPath}/create`,
      );
      expect(
        screen.getByRole("button", { name: /^Attach shared/ }),
      ).toBeInTheDocument();
    });

    it("shows the Organization's empty card with its create CTA when it has none", () => {
      authState.actor = "org-admin";
      mockScopedSWR({ [`/${entity}`]: [] });
      renderList(<List orgId="org1" />);

      expect(screen.getByText(/^No .* configured$/)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /^Add/ })).toHaveAttribute(
        "href",
        `/org1/${settingsPath}/create`,
      );
      expect(
        screen.queryByRole("button", { name: /^Attach shared/ }),
      ).not.toBeInTheDocument();
    });

    it("renders a fetch failure rather than swallowing it", () => {
      mockScopedSWR({
        [`/${entity}`]: {
          error: {
            message: "An error occurred while fetching the data.",
            info: { error: "Server exploded" },
          },
        },
      });
      renderList(<List orgId="org1" workspaceId="ws1" />);

      expect(
        screen.getByText(`Failed to load ${fetchErrorNoun}. Server exploded`),
      ).toBeInTheDocument();
    });

    // Rows and the caller's own Add / Attach buttons, so neither pops in —
    // and nothing clickable until the read lands.
    it("holds the rows and action buttons with a skeleton while loading", () => {
      authState.actor = "org-admin";
      mockScopedSWR({ [`/${entity}`]: { isLoading: true } });
      renderList(<List orgId="org1" workspaceId="ws1" />);

      expect(
        screen.getByRole("status", { name: `Loading ${fetchErrorNoun}` }),
      ).toHaveAttribute("aria-busy", "true");
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
      expect(screen.queryByText(/configured/)).not.toBeInTheDocument();
    });

    it("shows the row's second line under its name", () => {
      renderRows([workspaceItem]);

      expect(screen.getByText(secondLine)).toBeInTheDocument();
    });

    // A long URL is cut off with an ellipsis inside the card, so the full
    // value stays readable on hover.
    it("truncates the row's second line, keeping the full value on hover", () => {
      renderRows([workspaceItem]);

      const line = screen.getByText(secondLine);
      expect(line).toHaveClass("truncate");
      expect(line).toHaveAttribute("title", secondLine);
    });

    it("gives a workspace row Edit, then Delete", () => {
      renderRows([workspaceItem]);
      openDropdownMenu();

      expect(menuItemLabels()).toEqual(["Edit", "Delete"]);
    });

    it("gives a row the caller can't manage only Edit", () => {
      authState.actor = "workspace-owner";
      authState.workspaceDelegation = { [delegationFlag]: false };
      renderRows([workspaceItem]);
      openDropdownMenu();

      expect(menuItemLabels()).toEqual(["Edit"]);
    });

    it("deletes a workspace row after confirmation and revalidates", async () => {
      const fetchMock = stubAcceptedSave();
      renderRows([workspaceItem]);
      openDropdownMenu();
      fireEvent.click(screen.getByText("Delete"));

      expect(fetchMock).not.toHaveBeenCalled();
      await confirmDialog("Delete");

      await waitFor(() => expect(mutate).toHaveBeenCalled());
      expect(fetchMock).toHaveBeenCalledWith(
        `http://test/organizations/org1/workspaces/ws1/${entity}/${workspaceItem.id}`,
        expect.objectContaining({ method: "DELETE" }),
      );
    });

    it("gives a Shared row Edit in org settings, then Detach, and no click action", () => {
      renderRows([item]);
      fireEvent.click(screen.getByText(item.name));
      expect(screen.queryByText(dialogTitle)).not.toBeInTheDocument();
      expect(screen.getByText(item.name).closest("a")).toBeNull();

      openDropdownMenu();
      expect(menuItemLabels()).toEqual(["Edit in org settings", "Detach"]);
      expect(
        screen.getByRole("menuitem", { name: /Edit in org settings/ }),
      ).toHaveAttribute("href", `/org1/${settingsPath}/${item.id}`);
    });

    it("gives a Shared row no menu when the caller can't manage Shared resources", () => {
      authState.actor = "workspace-owner";
      renderRows([item]);

      expect(
        screen.queryByRole("button", { name: `Actions for ${item.name}` }),
      ).not.toBeInTheDocument();
    });

    it("points the detach dialog's Org settings link at the organization page", () => {
      renderRows([item]);
      openDropdownMenu();
      fireEvent.click(screen.getByText("Detach"));

      expect(
        screen.getByRole("link", { name: /Org settings/ }),
      ).toHaveAttribute("href", `/org1/${settingsPath}/${item.id}`);
    });

    it("detaches through the request module and revalidates on success", async () => {
      const fetchMock = stubAcceptedSave();

      renderRows([item]);
      openDropdownMenu();
      fireEvent.click(screen.getByText("Detach"));
      fireEvent.click(screen.getByRole("button", { name: /Detach/ }));

      await waitFor(() => expect(mutate).toHaveBeenCalled());
      expect(fetchMock).toHaveBeenCalledWith(
        `http://test/organizations/org1/workspaces/ws1/attachments/${resourceType}/${item.id}`,
        expect.objectContaining({ method: "DELETE" }),
      );
      expect(screen.queryByText(dialogTitle)).not.toBeInTheDocument();
    });

    describe("on the Organization surface", () => {
      /** Renders the Organization surface with `rows` in the list. */
      const renderOrgRows = (rows: ScopedResource[], menuItem?: string) => {
        mockScopedSWR({ [`/${entity}`]: rows });
        return renderList(<List orgId="org1" />, menuItem);
      };

      it("gives an Org Admin's row Edit, Manage attachments, then Delete", () => {
        authState.actor = "org-admin";
        renderOrgRows([item]);
        openDropdownMenu();

        expect(menuItemLabels()).toEqual([
          "Edit",
          "Manage attachments",
          "Delete",
        ]);
      });

      it("attaches the row to a Workspace from Manage attachments", async () => {
        authState.actor = "org-admin";
        const fetchMock = stubAcceptedSave();
        mockScopedSWR({
          "/attachments?": [],
          "/workspaces": [{ id: "ws1", name: "Engineering" }],
        });
        renderOrgRows([item], "Manage attachments");
        fireEvent.click(await screen.findByText("Engineering"));

        await waitFor(() =>
          expect(fetchMock).toHaveBeenCalledWith(
            "http://test/organizations/org1/attachments",
            expect.objectContaining({
              method: "POST",
              body: JSON.stringify({
                resourceType,
                resourceId: item.id,
                workspaceId: "ws1",
              }),
            }),
          ),
        );
      });

      it("shows an Org Admin how many Workspaces each row is shared with", () => {
        authState.actor = "org-admin";
        mockScopedSWR({
          "/attachments?": [{ workspaceId: "ws1", workspaceName: "Eng" }],
        });
        renderOrgRows([item]);

        expect(screen.getByText("1 workspace")).toBeInTheDocument();
      });

      it("shows a non-admin neither the badge nor Manage attachments", () => {
        authState.actor = "member";
        mockScopedSWR({
          "/attachments?": [{ workspaceId: "ws1", workspaceName: "Eng" }],
        });
        renderOrgRows([item]);

        expect(screen.queryByText("1 workspace")).not.toBeInTheDocument();
        openDropdownMenu();
        expect(menuItemLabels()).toEqual(["Edit", "Delete"]);
      });

      it("blocks deleting a row still attached to a Workspace, sending no DELETE", async () => {
        authState.actor = "org-admin";
        const fetchMock = stubAcceptedSave({ results: [{ id: "att1" }] });
        renderOrgRows([item], "Delete");

        expect(
          await screen.findByText(/is shared with 1 workspace\./),
        ).toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledWith(
          `http://test/organizations/org1/attachments?resourceType=${resourceType}&resourceId=${item.id}`,
          expect.objectContaining({ credentials: "include" }),
        );
        expect(fetchMock).not.toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ method: "DELETE" }),
        );
      });

      it("deletes an unattached row after confirmation", async () => {
        authState.actor = "org-admin";
        const fetchMock = stubSaveSequence(
          { status: 200, body: { results: [] } },
          { status: 200, body: {} },
        );
        renderOrgRows([item], "Delete");
        await confirmDialog("Delete");

        await waitFor(() => expect(mutate).toHaveBeenCalled());
        expect(fetchMock).toHaveBeenCalledWith(
          `http://test/organizations/org1/${entity}/${item.id}`,
          expect.objectContaining({ method: "DELETE" }),
        );
      });
    });

    it("surfaces the backend's reason and keeps the dialog open when detach is refused", async () => {
      stubRejectedSave(
        "This resource is in use by an agent in this workspace",
        409,
      );

      renderRows([item]);
      openDropdownMenu();
      fireEvent.click(screen.getByText("Detach"));
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
