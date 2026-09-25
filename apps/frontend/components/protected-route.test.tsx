import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProtectedRoute } from "./protected-route";

const { auth, push } = vi.hoisted(() => ({
  auth: {
    user: { id: "u1" } as { id: string } | null,
    isAuthLoading: false,
    orgMembership: { role: "member" } as { role: string } | null,
    actor: "org-member",
  },
  push: vi.fn(),
}));

vi.mock("@/components/auth-provider", () => ({ useAuth: () => auth }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useParams: () => ({ orgId: "org1" }),
}));

const renderGate = (
  props: Omit<Parameters<typeof ProtectedRoute>[0], "children">,
) =>
  render(
    <ProtectedRoute {...props}>
      <p>Secret page</p>
    </ProtectedRoute>,
  );

beforeEach(() => {
  push.mockReset();
  Object.assign(auth, {
    user: { id: "u1" },
    isAuthLoading: false,
    orgMembership: { role: "member" },
    actor: "org-member",
  });
});

describe("ProtectedRoute", () => {
  it("sends a signed-out reader to sign in and renders nothing", () => {
    auth.user = null;
    const { container } = renderGate({ requireOrgAccess: true });

    expect(push).toHaveBeenCalledWith("/sign-in");
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    {
      name: "a non-Operator from an Operator page",
      state: { actor: "org-admin", orgMembership: { role: "admin" } },
      props: { requireSuperAdmin: true },
      title: "Super Admin Access Required",
      back: ["Return Home", "/"],
    },
    {
      name: "a non-member from an Organization",
      state: { actor: "org-member", orgMembership: null },
      props: { requireOrgAccess: true },
      title: "Organization Access Required",
      back: ["Return Home", "/"],
    },
    {
      name: "a plain member from an Org Admin page",
      state: { actor: "workspace-owner", orgMembership: { role: "member" } },
      props: { requireOrgAccess: true, requireOrgAdmin: true },
      title: "Insufficient Organization Permissions",
      back: ["Return Home", "/"],
    },
    {
      name: "a member from a Workspace they don't own",
      state: { actor: "org-member", orgMembership: { role: "member" } },
      props: { requireOrgAccess: true, requireWorkspaceAccess: true },
      title: "Workspace Access Required",
      back: ["Back to Organization", "/org1"],
    },
  ])("turns away $name", ({ state, props, title, back: [label, href] }) => {
    Object.assign(auth, state);
    renderGate(props);

    expect(screen.getByText(title)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: label })).toHaveAttribute(
      "href",
      href,
    );
    expect(screen.queryByText("Secret page")).toBeNull();
  });

  it.each([
    {
      name: "an Operator who is not a member",
      state: { actor: "operator", orgMembership: null },
      props: {
        requireSuperAdmin: true,
        requireOrgAccess: true,
        requireOrgAdmin: true,
      },
    },
    {
      name: "an Org Admin on an Org Admin page",
      state: { actor: "org-admin", orgMembership: { role: "admin" } },
      props: { requireOrgAccess: true, requireOrgAdmin: true },
    },
    {
      name: "a Workspace Owner in their Workspace",
      state: { actor: "workspace-owner", orgMembership: { role: "member" } },
      props: { requireOrgAccess: true, requireWorkspaceAccess: true },
    },
  ])("lets in $name", ({ state, props }) => {
    Object.assign(auth, state);
    renderGate(props);

    expect(screen.getByText("Secret page")).toBeInTheDocument();
  });

  // The gate only decides once the session has resolved.
  it("renders the page while the session is still resolving", () => {
    Object.assign(auth, { user: null, isAuthLoading: true });
    renderGate({ requireSuperAdmin: true });

    expect(screen.getByText("Secret page")).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });
});
