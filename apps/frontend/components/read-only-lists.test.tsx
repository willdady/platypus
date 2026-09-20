import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen } from "@testing-library/react";
import type { Workspace } from "@platypus/schemas";
import {
  authMock,
  swrMock,
  mockScopedSWR,
  resetListHarness,
  renderList,
} from "@/lib/list-test-harness";

// --- Module mocks ------------------------------------------------------------

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("swr", () => swrMock);

import { ContextsList } from "./contexts-list";
import { WebhooksList } from "./webhooks-list";
import { WorkspaceList } from "./workspace-list";
import { PluginsList } from "./plugins-list";

/**
 * The lists with no row actions — nothing to delete, so the whole of their
 * behaviour is which of loading, empty, failed and populated they render.
 * Each answers those four differently on purpose (a skeleton here, a silent
 * null there), and until now none of them had a test saying so.
 */

beforeEach(resetListHarness);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ContextsList", () => {
  const workspaceContext = {
    id: "ctx1",
    workspaceId: "ws1",
    workspaceName: "Engineering",
    organizationName: "Acme",
  };

  it("lists each workspace context under its organization", () => {
    mockScopedSWR({ contexts: [workspaceContext] });
    renderList(<ContextsList />);

    expect(screen.getByText("Engineering")).toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
  });

  // A personal context has no workspace, and this list is the workspace one.
  it("leaves out a context that belongs to no workspace", () => {
    mockScopedSWR({
      contexts: [{ id: "ctx2", workspaceId: null, workspaceName: null }],
    });
    renderList(<ContextsList />);

    expect(screen.getByText("No workspace contexts.")).toBeInTheDocument();
  });

  it("offers the create CTA when there are none", () => {
    mockScopedSWR({ contexts: [] });
    renderList(<ContextsList />);

    expect(screen.getByText("No workspace contexts.")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Add workspace context/ }),
    ).toBeInTheDocument();
  });

  // The page around it already reads these; a failure here would double up on
  // whatever it says, so this list stays quiet.
  it.each([
    ["the read fails", { error: new Error("500") }],
    ["the read is still in flight", { isLoading: true }],
  ])("renders nothing while %s", (_, read) => {
    mockScopedSWR({ contexts: read });
    const { container } = renderList(<ContextsList />);

    expect(container).toBeEmptyDOMElement();
  });
});

describe("WebhooksList", () => {
  const webhook = {
    id: "wh1",
    workspaceId: "ws1",
    name: "Deploy hook",
    url: "https://hooks.example.com/deploy",
    enabled: true,
  };

  const render = () =>
    renderList(<WebhooksList orgId="org1" workspaceId="ws1" />);

  it("links each webhook to its detail page and shows its URL", () => {
    mockScopedSWR({ webhooks: [webhook] });
    render();

    expect(screen.getByText("Deploy hook").closest("a")).toHaveAttribute(
      "href",
      "/org1/workspace/ws1/settings/webhooks/wh1",
    );
    expect(
      screen.getByText("https://hooks.example.com/deploy"),
    ).toBeInTheDocument();
  });

  // A disabled webhook still lists, badged — deleting it to turn it off would
  // lose its URL and secret.
  it("badges a disabled webhook rather than hiding it", () => {
    mockScopedSWR({ webhooks: [{ ...webhook, enabled: false }] });
    render();

    expect(screen.getByText("Deploy hook")).toBeInTheDocument();
    expect(screen.getByText("Disabled")).toBeInTheDocument();
  });

  it("offers the create CTA when the workspace has none", () => {
    mockScopedSWR({ webhooks: [] });
    render();

    expect(
      screen.getByText("No webhooks configured for this workspace."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Add webhook/ }),
    ).toBeInTheDocument();
  });

  it("says the read failed rather than claiming there are none", () => {
    mockScopedSWR({ webhooks: { error: new Error("500") } });
    render();

    expect(screen.getByText("Failed to load webhooks.")).toBeInTheDocument();
    expect(
      screen.queryByText("No webhooks configured for this workspace."),
    ).not.toBeInTheDocument();
  });
});

describe("WorkspaceList", () => {
  const workspace = (id: string, name: string) =>
    ({ id, name }) as unknown as Workspace;

  it("lists the organization's workspaces by name, sorted", () => {
    mockScopedSWR({
      workspaces: [workspace("ws2", "Research"), workspace("ws1", "Delivery")],
    });
    renderList(<WorkspaceList orgId="org1" />);

    const names = screen
      .getAllByRole("link")
      .map((link) => link.textContent?.trim());
    expect(names).toEqual(["Delivery", "Research"]);
    expect(screen.getByText("Delivery").closest("a")).toHaveAttribute(
      "href",
      "/org1/workspace/ws1",
    );
  });

  // Empty and loading both render no links, so the pair is what tells them
  // apart: the skeletons are the whole of the loading state.
  it("renders no rows and no skeletons when the organization has none", () => {
    mockScopedSWR({ workspaces: [] });
    const { container } = renderList(<WorkspaceList orgId="org1" />);

    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(
      0,
    );
  });

  it("holds the row space with skeletons while the read is in flight", () => {
    mockScopedSWR({ workspaces: { isLoading: true } });
    const { container } = renderList(<WorkspaceList orgId="org1" />);

    expect(
      container.querySelectorAll('[data-slot="skeleton"]').length,
    ).toBeGreaterThan(0);
  });

  // The sidebar that hosts it has nowhere to put a failure, so it stays quiet.
  it("renders nothing when the read fails", () => {
    mockScopedSWR({ workspaces: { error: new Error("500") } });
    const { container } = renderList(<WorkspaceList orgId="org1" />);

    expect(container).toBeEmptyDOMElement();
  });
});

describe("PluginsList", () => {
  it("names each installed plugin", () => {
    mockScopedSWR({
      plugins: [
        {
          name: "acme-search",
          version: "1.2.0",
          contributions: {
            toolSets: [],
            sandboxBackends: [],
            webBackends: ["searx"],
          },
        },
      ],
    });
    renderList(<PluginsList orgId="org1" />);

    expect(screen.getByText("acme-search")).toBeInTheDocument();
  });

  // Plugins are a deploy-time concern, so the empty state has to send the
  // reader to their operator rather than offer an install button.
  it("points an empty deployment at its operator, not an install flow", () => {
    mockScopedSWR({ plugins: [] });
    renderList(<PluginsList orgId="org1" />);

    expect(screen.getByText("No plugins installed")).toBeInTheDocument();
    expect(screen.getByText("PLATYPUS_PLUGINS")).toBeInTheDocument();
  });

  it("distinguishes a failed catalog read from an empty one", () => {
    mockScopedSWR({ plugins: { error: new Error("500") } });
    renderList(<PluginsList orgId="org1" />);

    expect(screen.getByText("Couldn't load plugins")).toBeInTheDocument();
    expect(screen.queryByText("No plugins installed")).not.toBeInTheDocument();
  });
});
