import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import { installMatchMediaStub } from "@/lib/test-utils";
import type { Actor, OrgRole } from "@/lib/authorization";

const auth = vi.hoisted(() => ({
  actor: "org-member" as Actor,
  orgMembership: { role: "member" } as { role: OrgRole } | null,
}));
const reads = vi.hoisted(() => ({ workspaces: [] as unknown[] }));

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgId: "org1" }),
  usePathname: () => "/org1",
}));

vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://test",
  useAuth: () => ({ ...auth, isAuthLoading: false }),
}));

vi.mock("@/hooks/use-scoped-swr", () => ({
  useScopedSWR: () => ({
    data: { results: reads.workspaces },
    error: undefined,
    isLoading: false,
  }),
}));

import { OrgHome } from "./org-home";

beforeAll(installMatchMediaStub);

const viewers: [string, Actor, OrgRole | null, boolean][] = [
  ["an Org Member", "org-member", "member", false],
  ["a member who owns a Workspace", "workspace-owner", "member", false],
  ["an Org Admin", "org-admin", "admin", true],
  ["the Operator, outside the Organization", "operator", null, true],
];

describe.each([
  ["with Workspaces", [{ id: "ws1", name: "Alpha", organizationId: "org1" }]],
  ["with no Workspaces", []],
])("OrgHome %s", (_label, workspaces) => {
  it.each(viewers)(
    "%s sees Add workspace and Organization settings: %s",
    (_who, actor, role, shown) => {
      auth.actor = actor;
      auth.orgMembership = role ? { role } : null;
      reads.workspaces = workspaces;
      render(<OrgHome orgId="org1" />);

      for (const name of [/Add workspace/, /Organization settings/]) {
        expect(screen.queryByRole("link", { name }) !== null).toBe(shown);
      }
    },
  );
});
