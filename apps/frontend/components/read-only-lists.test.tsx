import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import type { Workspace } from "@platypus/schemas";
import {
  authMock,
  swrMock,
  mockScopedSWR,
  resetListHarness,
  renderList,
  expectEntryActionVariant,
} from "@/test/list-test-harness";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("swr", () => swrMock);

import { ContextsList } from "./contexts-list";
import { WorkspaceList } from "./workspace-list";
import { PluginsList } from "./plugins-list";

beforeEach(resetListHarness);

describe("ContextsList", () => {
  const workspaceContext = {
    id: "ctx1",
    workspaceId: "ws1",
    workspaceName: "Engineering",
    organizationName: "Acme",
  };

  const addContext = () =>
    screen.getByRole("link", { name: /Add workspace context/ });

  it("lists each workspace context under its organization", async () => {
    mockScopedSWR({ contexts: [workspaceContext] }, { strict: true });
    await renderList(<ContextsList />);

    expect(screen.getByText("Engineering")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Engineering/ })).toHaveAttribute(
      "href",
      "/settings/contexts/ctx1",
    );
    expect(screen.getByText("Acme")).toBeInTheDocument();
  });

  it("offers Edit in the card's menu", async () => {
    mockScopedSWR({ contexts: [workspaceContext] }, { strict: true });
    await renderList(<ContextsList />);

    expect(
      screen.getByRole("button", { name: "Actions for Engineering" }),
    ).toBeInTheDocument();
  });

  it("leaves out a context that belongs to no workspace", async () => {
    mockScopedSWR(
      {
        contexts: [{ id: "ctx2", workspaceId: null, workspaceName: null }],
      },
      { strict: true },
    );
    await renderList(<ContextsList />);

    expect(screen.getByText("No workspace contexts yet.")).toBeInTheDocument();
  });

  it("offers the create CTA when there are none", async () => {
    mockScopedSWR({ contexts: [] }, { strict: true });
    await renderList(<ContextsList />);

    expect(screen.getByText("No workspace contexts yet.")).toBeInTheDocument();
    expect(addContext()).toBeInTheDocument();
  });

  it("keeps the create CTA below a populated list, outlined", async () => {
    mockScopedSWR({ contexts: [workspaceContext] }, { strict: true });
    await renderList(<ContextsList />);

    expectEntryActionVariant(addContext(), "populated");
  });

  it("holds the row space with skeletons while the read is in flight", async () => {
    mockScopedSWR({ contexts: { isLoading: true } }, { strict: true });
    await renderList(<ContextsList />);

    expect(
      screen.getByRole("status", { name: "Loading workspace contexts" }),
    ).toBeInTheDocument();
    expect(addContext()).toBeInTheDocument();
    expect(
      screen.queryByText("No workspace contexts yet."),
    ).not.toBeInTheDocument();
  });

  it("says the read failed rather than rendering nothing", async () => {
    mockScopedSWR({ contexts: { error: new Error("500") } }, { strict: true });
    await renderList(<ContextsList />);

    expect(
      screen.getByText("Failed to load workspace contexts. 500"),
    ).toBeInTheDocument();
    expect(addContext()).toBeInTheDocument();
    expect(
      screen.queryByText("No workspace contexts yet."),
    ).not.toBeInTheDocument();
  });

  it("keeps the rows when only a revalidation fails", async () => {
    mockScopedSWR(
      {
        contexts: {
          data: { results: [workspaceContext] },
          error: new Error("500"),
        },
      },
      { strict: true },
    );
    await renderList(<ContextsList />);

    expect(screen.getByText("Engineering")).toBeInTheDocument();
    expect(
      screen.queryByText(/Failed to load workspace contexts/),
    ).not.toBeInTheDocument();
  });
});

describe("WorkspaceList", () => {
  const workspace = (id: string, name: string) =>
    ({ id, name }) as unknown as Workspace;

  it("lists the organization's workspaces by name, sorted", async () => {
    mockScopedSWR(
      {
        workspaces: [
          workspace("ws2", "Research"),
          workspace("ws1", "Delivery"),
        ],
      },
      { strict: true },
    );
    await renderList(<WorkspaceList orgId="org1" />);

    const names = screen
      .getAllByRole("link")
      .map((link) => link.textContent?.trim());
    expect(names).toEqual(["Delivery", "Research"]);
    expect(screen.getByText("Delivery")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Delivery/ })).toHaveAttribute(
      "href",
      "/org1/workspace/ws1",
    );
  });

  it("renders no rows and no skeletons when the organization has none", async () => {
    mockScopedSWR({ workspaces: [] }, { strict: true });
    await renderList(<WorkspaceList orgId="org1" />);

    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.queryAllByTestId("workspace-skeleton")).toHaveLength(0);
  });

  it("holds the row space with skeletons while the read is in flight", async () => {
    mockScopedSWR({ workspaces: { isLoading: true } }, { strict: true });
    await renderList(<WorkspaceList orgId="org1" />);

    expect(
      screen.getByRole("status", { name: "Loading workspaces" }),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId("workspace-skeleton").length).toBeGreaterThan(
      0,
    );
  });

  it("says the read failed rather than rendering nothing", async () => {
    mockScopedSWR(
      { workspaces: { error: new Error("500") } },
      { strict: true },
    );
    await renderList(<WorkspaceList orgId="org1" />);

    expect(screen.getByText(/Failed to load workspaces/)).toBeInTheDocument();
  });
});

describe("PluginsList", () => {
  it("names each installed plugin", async () => {
    mockScopedSWR(
      {
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
      },
      { strict: true },
    );
    await renderList(<PluginsList orgId="org1" />);

    expect(screen.getByText("acme-search")).toBeInTheDocument();
  });

  it("points an empty deployment at its operator, not an install flow", async () => {
    mockScopedSWR({ plugins: [] }, { strict: true });
    await renderList(<PluginsList orgId="org1" />);

    expect(screen.getByText("No plugins installed")).toBeInTheDocument();
    expect(screen.getByText("PLATYPUS_PLUGINS")).toBeInTheDocument();
  });

  it("holds a placeholder, not the empty state, until the catalog arrives", async () => {
    mockScopedSWR({ plugins: { data: undefined } }, { strict: true });
    await renderList(<PluginsList orgId="org1" />);

    expect(
      screen.getByRole("status", { name: "Loading plugins" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("No plugins installed")).not.toBeInTheDocument();
  });

  it("distinguishes a failed catalog read from an empty one", async () => {
    mockScopedSWR({ plugins: { error: new Error("500") } }, { strict: true });
    await renderList(<PluginsList orgId="org1" />);

    expect(screen.getByText("Couldn't load plugins")).toBeInTheDocument();
    expect(screen.queryByText("No plugins installed")).not.toBeInTheDocument();
  });

  it("keeps the rows when only a revalidation fails", async () => {
    mockScopedSWR(
      {
        plugins: {
          data: {
            results: [
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
          },
          error: new Error("500"),
        },
      },
      { strict: true },
    );
    await renderList(<PluginsList orgId="org1" />);

    expect(screen.getByText("acme-search")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load plugins")).not.toBeInTheDocument();
  });
});
