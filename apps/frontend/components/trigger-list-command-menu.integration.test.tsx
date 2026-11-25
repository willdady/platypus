import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { SWRConfig } from "swr";
import type { Trigger } from "@platypus/schemas";
import {
  authMock,
  authState,
  jsonResponse,
  openDropdownMenu,
  setupUser,
} from "@/test/test-utils";
import { CommandMenu } from "./command-menu";
import { TriggerList } from "./trigger-list";

// why: real SWR, faked fetch — a forgotten revalidation leaves the menu stale

vi.mock("@/components/auth-provider", () => authMock);

const BASE = "http://test/organizations/org1/workspaces/ws1";

function cronTrigger(id: string, name: string): Trigger {
  return {
    id,
    name,
    type: "cron",
    enabled: true,
    agentId: "agent1",
    config: { cronExpression: "0 0 * * *", timezone: "UTC" },
  } as unknown as Trigger;
}

// why: a spent One-off — the list shows it, the command menu never does
const firedOneOff = {
  ...cronTrigger("t3", "Spent job"),
  config: { cronExpression: "0 0 * * *", timezone: "UTC", isOneOff: true },
  firedAt: "2026-02-01T08:00:00.000Z",
} as unknown as Trigger;

let triggers: Trigger[];
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  authState.user = { id: "u1" };
  triggers = [
    cronTrigger("t1", "Alpha job"),
    cronTrigger("t2", "Beta job"),
    firedOneOff,
  ];
  fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    if (init?.method === "DELETE") {
      triggers = triggers.filter((trigger) => !url.endsWith(trigger.id));
      return Promise.resolve(jsonResponse(200, {}));
    }
    if (url.startsWith(`${BASE}/triggers`)) {
      const rows = url.includes("includeFired=true")
        ? triggers
        : triggers.filter((trigger) => !trigger.firedAt);
      return Promise.resolve(jsonResponse(200, { results: rows }));
    }
    // why: every other list the command menu reads is empty
    return Promise.resolve(jsonResponse(200, { results: [] }));
  });
  vi.stubGlobal("fetch", fetchMock);
});

function renderTriggersAndMenu() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <CommandMenu orgId="org1" workspaceId="ws1" />
      <TriggerList orgId="org1" workspaceId="ws1" />
    </SWRConfig>,
  );
}

function toggleMenu() {
  act(() => {
    fireEvent.keyDown(document, { key: "k", metaKey: true });
  });
}

async function deleteFirstTrigger() {
  await openDropdownMenu();
  const user = setupUser();
  await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
  await user.click(await screen.findByRole("button", { name: "Delete" }));
}

describe("the command menu's Trigger list", () => {
  it("drops a Trigger deleted from the Triggers list", async () => {
    renderTriggersAndMenu();
    await screen.findByText("Alpha job");

    toggleMenu();
    const menu = await screen.findByRole("dialog");
    expect(
      await within(menu).findByRole("option", { name: "Alpha job" }),
    ).toBeInTheDocument();
    expect(
      within(menu).queryByRole("option", { name: "Spent job" }),
    ).not.toBeInTheDocument();

    toggleMenu();
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await deleteFirstTrigger();

    await screen.findByText("Beta job");
    expect(screen.queryByText("Alpha job")).not.toBeInTheDocument();

    toggleMenu();
    const reopened = await screen.findByRole("dialog");
    expect(
      await within(reopened).findByRole("option", { name: "Beta job" }),
    ).toBeInTheDocument();
    expect(
      within(reopened).queryByRole("option", { name: "Alpha job" }),
    ).not.toBeInTheDocument();
    expect(
      within(reopened).queryByRole("option", { name: "Spent job" }),
    ).not.toBeInTheDocument();
  });
});
