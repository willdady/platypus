import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import {
  installRadixPointerPolyfills,
  openDropdownMenu,
} from "@/lib/test-utils";

beforeAll(installRadixPointerPolyfills);

vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://test",
  useAuth: () => ({ user: { id: "u1" } }),
}));

interface SwrCall {
  key: string | null;
  config?: { refreshInterval?: number };
}

const { swrCalls } = vi.hoisted(() => ({
  swrCalls: [] as SwrCall[],
}));

vi.mock("swr", () => ({
  useSWRConfig: () => ({ cache: new Map() }),
  __esModule: true,
  default: (key: string | null, _fn: unknown, config?: SwrCall["config"]) => {
    swrCalls.push({ key, config });
    return { data: { results: [], count: 0 }, mutate: vi.fn() };
  },
}));

import { NotificationsDropdown } from "./notifications-dropdown";

function lastConfigFor(keyFragment: string): SwrCall["config"] {
  const call = [...swrCalls]
    .reverse()
    .find((c) => c.key?.includes(keyFragment));
  if (!call) throw new Error(`No SWR call for ${keyFragment}`);
  return call.config;
}

beforeEach(() => {
  swrCalls.length = 0;
});

describe("NotificationsDropdown polling", () => {
  it("does not poll any feed while the dropdown is closed", () => {
    render(<NotificationsDropdown orgId="org1" workspaceId="ws1" />);

    expect(lastConfigFor("/notifications")?.refreshInterval).toBe(0);
    expect(lastConfigFor("/unread-count")?.refreshInterval).toBe(0);
    expect(lastConfigFor("/users/me/invitations")?.refreshInterval).toBe(0);
  });

  it("starts polling the workspace feeds and invitations once opened", () => {
    render(<NotificationsDropdown orgId="org1" workspaceId="ws1" />);
    openDropdownMenu();

    expect(lastConfigFor("/notifications")?.refreshInterval).toBe(30000);
    expect(lastConfigFor("/unread-count")?.refreshInterval).toBe(30000);
    expect(lastConfigFor("/users/me/invitations")?.refreshInterval).toBe(
      120000,
    );
  });

  it("reads notifications through the workspace-scoped key", () => {
    render(<NotificationsDropdown orgId="org1" workspaceId="ws1" />);

    expect(
      swrCalls.some(
        (c) =>
          c.key ===
          "http://test/organizations/org1/workspaces/ws1/notifications",
      ),
    ).toBe(true);
  });
});
