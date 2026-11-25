import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { Actor } from "@/lib/authorization";

const { params, reads, auth } = vi.hoisted(() => ({
  params: { orgId: "org1", workspaceId: "ws1" },
  auth: {
    actor: "org-admin",
    ownsWorkspace: true,
    workspaceDelegation: null,
  },
  // why: keyed by workspaceId|entity, as the app sidebar's test does
  reads: new Map<string, { data: unknown; isLoading: boolean }>(),
}));

const path = { current: `/${params.orgId}/workspace/${params.workspaceId}` };

vi.mock("next/navigation", () => ({
  usePathname: () => path.current,
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
}));
vi.mock("@/components/back-button", () => ({
  BackButton: ({ fallbackHref }: { fallbackHref?: string }) => (
    <button aria-label="Back" data-fallback-href={fallbackHref} />
  ),
}));
vi.mock("@/components/user-menu", () => ({ UserMenu: () => null }));
vi.mock("@/components/mode-toggle", () => ({ ModeToggle: () => null }));
vi.mock("@/components/notifications-dropdown", () => ({
  NotificationsDropdown: () => null,
}));
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => auth,
  useBackendUrl: () => "http://test",
}));
vi.mock("@/hooks/use-scoped-swr", () => ({
  useScopedSWR: (entity: string, scope: { workspaceId?: string } | null) =>
    reads.get(`${scope?.workspaceId ?? ""}|${entity}`) ?? {
      data: undefined,
      isLoading: true,
    },
}));

import { WorkspaceShell } from "./workspace-shell";

function setRead(workspaceId: string, entity: string, data: unknown) {
  reads.set(`${workspaceId}|${entity}`, { data, isLoading: false });
}

function seedSwitcher() {
  setRead("", "organizations/org1", { id: "org1", name: "Acme" });
  setRead("", "workspaces", {
    results: [
      { id: "ws1", name: "Alpha", organizationId: "org1" },
      { id: "ws2", name: "Beta", organizationId: "org1" },
    ],
  });
}

function renderWorkspace() {
  return render(
    <WorkspaceShell orgId="org1" workspaceId="ws1">
      content
    </WorkspaceShell>,
  );
}

beforeEach(() => {
  reads.clear();
  auth.actor = "org-admin";
  path.current = `/${params.orgId}/workspace/${params.workspaceId}`;
});

describe("WorkspaceShell rail", () => {
  it("draws the rail with a link to Home, Boards, Artifacts and Workspace settings", () => {
    renderWorkspace();

    const rail = screen.getByRole("navigation", { name: "Workspace" });
    expect(within(rail).getAllByRole("link")).toHaveLength(4);
    expect(within(rail).getByRole("link", { name: "Home" })).toHaveAttribute(
      "href",
      "/org1/workspace/ws1",
    );
    expect(within(rail).getByRole("link", { name: "Boards" })).toHaveAttribute(
      "href",
      "/org1/workspace/ws1/boards",
    );
    expect(
      within(rail).getByRole("link", { name: "Artifacts" }),
    ).toHaveAttribute("href", "/org1/workspace/ws1/artifacts");
    expect(
      within(rail).getByRole("link", { name: "Workspace settings" }),
    ).toHaveAttribute("href", "/org1/workspace/ws1/settings");
  });

  it.each([
    ["the Workspace home", "/org1/workspace/ws1", "Home"],
    ["a Board", "/org1/workspace/ws1/boards/b1", "Boards"],
    ["the Boards list", "/org1/workspace/ws1/boards", "Boards"],
    ["a Board's settings", "/org1/workspace/ws1/boards/b1/settings", "Boards"],
    ["an Artifact", "/org1/workspace/ws1/artifacts/a1", "Artifacts"],
    ["the Artifacts list", "/org1/workspace/ws1/artifacts", "Artifacts"],
    ["an Agent", "/org1/workspace/ws1/agents/a1", "Home"],
    ["a Skill", "/org1/workspace/ws1/skills/create", "Home"],
    ["a Trigger", "/org1/workspace/ws1/triggers/t1", "Home"],
    ["a Trigger run", "/org1/workspace/ws1/trigger-runs/r1", "Home"],
    ["a Chat", "/org1/workspace/ws1/chat/c1", null],
    ["settings", "/org1/workspace/ws1/settings/webhooks", "Workspace settings"],
  ])("marks the rail link for %s", (_, pathname, current) => {
    path.current = pathname;
    renderWorkspace();

    const rail = screen.getByRole("navigation", { name: "Workspace" });
    const lit = within(rail)
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page")
      .map((link) => link.getAttribute("aria-label"));
    expect(lit).toEqual(current ? [current] : []);
  });

  it("names a rail link in a tooltip when it takes focus", async () => {
    renderWorkspace();

    const rail = screen.getByRole("navigation", { name: "Workspace" });
    within(rail).getByRole("link", { name: "Boards" }).focus();

    expect(await screen.findByRole("tooltip")).toHaveTextContent("Boards");
  });

  it("draws no rail on a shell with no Workspace", () => {
    render(<WorkspaceShell orgId="org1">content</WorkspaceShell>);

    expect(
      screen.queryByRole("navigation", { name: "Workspace" }),
    ).not.toBeInTheDocument();
  });
});

describe("WorkspaceShell menu", () => {
  const openMenu = () => {
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    return screen.getByRole("dialog");
  };

  it("draws a menu button on a Workspace screen", () => {
    renderWorkspace();

    expect(
      screen.getByRole("button", { name: "Open menu" }),
    ).toBeInTheDocument();
  });

  it("draws no menu button on a shell with no Workspace", () => {
    render(<WorkspaceShell orgId="org1">content</WorkspaceShell>);

    expect(
      screen.queryByRole("button", { name: "Open menu" }),
    ).not.toBeInTheDocument();
  });

  it("puts the switcher above the Workspace rows in the sheet", () => {
    seedSwitcher();
    renderWorkspace();

    const sheet = openMenu();
    const switcher = within(sheet).getByRole("button", { name: /Acme/ });
    const nav = within(sheet).getByRole("navigation", { name: "Workspace" });

    expect(
      switcher.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => link.textContent?.trim()),
    ).toEqual(["Home", "Boards", "Artifacts", "Workspace settings"]);
    expect(within(nav).getByRole("link", { name: "Home" })).toHaveAttribute(
      "href",
      "/org1/workspace/ws1",
    );
    expect(within(nav).getByRole("link", { name: "Boards" })).toHaveAttribute(
      "href",
      "/org1/workspace/ws1/boards",
    );
    expect(
      within(nav).getByRole("link", { name: "Artifacts" }),
    ).toHaveAttribute("href", "/org1/workspace/ws1/artifacts");
    expect(
      within(sheet).queryByRole("link", { name: "New chat" }),
    ).not.toBeInTheDocument();
    expect(
      within(sheet).queryByRole("searchbox", { name: "Search chats" }),
    ).not.toBeInTheDocument();
  });

  it.each([
    ["the Workspace home", "/org1/workspace/ws1", "Home"],
    ["a Board", "/org1/workspace/ws1/boards/b1", "Boards"],
    ["an Artifact", "/org1/workspace/ws1/artifacts/a1", "Artifacts"],
    ["an Agent", "/org1/workspace/ws1/agents/a1", "Home"],
    ["a Chat", "/org1/workspace/ws1/chat/c1", null],
    ["settings", "/org1/workspace/ws1/settings/webhooks", "Workspace settings"],
  ])("marks the sheet row for %s", (_, pathname, current) => {
    path.current = pathname;
    renderWorkspace();

    const nav = within(openMenu()).getByRole("navigation", {
      name: "Workspace",
    });
    const lit = within(nav)
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page")
      .map((link) => link.textContent?.trim());
    expect(lit).toEqual(current ? [current] : []);
  });

  it("closes the sheet when a destination is picked", () => {
    renderWorkspace();

    const sheet = openMenu();
    fireEvent.click(within(sheet).getByRole("link", { name: "Boards" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("WorkspaceShell header", () => {
  it("puts the switcher where Home was on a Workspace screen", () => {
    seedSwitcher();
    renderWorkspace();

    expect(
      screen.queryByRole("link", { name: "Workspace home" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Acme\s*\/\s*Alpha/ }),
    ).toBeInTheDocument();
  });

  it("keeps Home and shows no switcher when there is no Workspace", () => {
    render(<WorkspaceShell orgId="org1">content</WorkspaceShell>);

    expect(
      screen.getByRole("link", { name: "Organization home" }),
    ).toHaveAttribute("href", "/org1");
    expect(screen.queryByTestId("org-name-skeleton")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("workspace-name-skeleton"),
    ).not.toBeInTheDocument();
  });
});

describe("WorkspaceShell switcher", () => {
  it("shows name placeholders while the Organization and Workspaces load", () => {
    renderWorkspace();

    expect(screen.getByTestId("org-name-skeleton")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-name-skeleton")).toBeInTheDocument();
  });

  it("swaps the placeholders for the names once loaded", () => {
    seedSwitcher();
    renderWorkspace();

    expect(screen.queryByTestId("org-name-skeleton")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("workspace-name-skeleton"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
  });

  const openSwitcher = () => {
    const trigger = screen.getByRole("button", { name: /Alpha/ });
    fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(trigger, { button: 0, pointerId: 1 });
    fireEvent.click(trigger, { button: 0 });
    return screen.getByRole("menu");
  };

  it("lists Workspaces by name without reordering the cached results", () => {
    const workspaces = {
      results: [
        { id: "ws2", name: "Beta", organizationId: "org1" },
        { id: "ws1", name: "Alpha", organizationId: "org1" },
      ],
    };
    setRead("", "organizations/org1", { id: "org1", name: "Acme" });
    setRead("", "workspaces", workspaces);
    renderWorkspace();

    const names = within(openSwitcher())
      .getAllByRole("menuitem")
      .map((item) => item.textContent?.trim())
      .filter((name) => name === "Alpha" || name === "Beta");
    expect(names).toEqual(["Alpha", "Beta"]);
    expect(workspaces.results.map((w) => w.name)).toEqual(["Beta", "Alpha"]);
  });

  it.each([
    ["the Operator", "operator", true],
    ["an Org Admin", "org-admin", true],
    ["a member who owns the Workspace", "workspace-owner", false],
  ] as const)("offers Add workspace to %s (%s): %s", (_who, actor, shown) => {
    auth.actor = actor;
    seedSwitcher();
    renderWorkspace();

    const item = within(openSwitcher()).queryByRole("menuitem", {
      name: /Add workspace/,
    });
    expect(item !== null).toBe(shown);
  });

  describe("Organization settings item", () => {
    it.each<Actor>(["operator", "org-admin"])(
      "links the %s to the Organization's settings",
      (actor) => {
        auth.actor = actor;
        seedSwitcher();
        renderWorkspace();

        const item = within(openSwitcher()).getByRole("menuitem", {
          name: "Organization settings",
        });
        expect(item).toHaveAttribute("href", "/org1/settings");
      },
    );

    it.each<Actor>(["workspace-owner", "org-member"])(
      "hides it from the %s",
      (actor) => {
        auth.actor = actor;
        seedSwitcher();
        renderWorkspace();

        expect(
          within(openSwitcher()).queryByRole("menuitem", {
            name: "Organization settings",
          }),
        ).not.toBeInTheDocument();
      },
    );
  });
});

describe("WorkspaceShell Back", () => {
  it.each([
    ["the Boards list", "/org1/workspace/ws1/boards"],
    ["the Artifacts list", "/org1/workspace/ws1/artifacts"],
  ])("leaves Back off %s", (_, pathname) => {
    path.current = pathname;
    renderWorkspace();

    expect(
      screen.queryByRole("button", { name: "Back" }),
    ).not.toBeInTheDocument();
  });

  it.each([
    ["a Board", "/org1/workspace/ws1/boards/b1"],
    ["a Board's settings", "/org1/workspace/ws1/boards/b1/settings"],
    ["the create form", "/org1/workspace/ws1/boards/create"],
  ])("sends the Back fallback from %s to the Boards list", (_, pathname) => {
    path.current = pathname;
    renderWorkspace();

    expect(screen.getByRole("button", { name: "Back" })).toHaveAttribute(
      "data-fallback-href",
      "/org1/workspace/ws1/boards",
    );
  });

  it.each([["an Artifact", "/org1/workspace/ws1/artifacts/a1"]])(
    "sends the Back fallback from %s to the Artifacts list",
    (_, pathname) => {
      path.current = pathname;
      renderWorkspace();

      expect(screen.getByRole("button", { name: "Back" })).toHaveAttribute(
        "data-fallback-href",
        "/org1/workspace/ws1/artifacts",
      );
    },
  );

  it.each([
    ["an Agent", "/org1/workspace/ws1/agents/a1"],
    ["settings", "/org1/workspace/ws1/settings"],
  ])("sends the Back fallback from %s to the Workspace home", (_, pathname) => {
    path.current = pathname;
    renderWorkspace();

    expect(screen.getByRole("button", { name: "Back" })).toHaveAttribute(
      "data-fallback-href",
      "/org1/workspace/ws1",
    );
  });
});
