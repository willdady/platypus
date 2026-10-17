import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ProtectedRoute } from "./protected-route";

const { auth, replace } = vi.hoisted(() => ({
  auth: {
    user: { id: "u1" } as { id: string } | null,
    isAuthLoading: false,
    orgMembership: { role: "member" } as { role: string } | null,
    actor: "org-member",
    accessReadError: null as unknown,
    retryAccessReads: vi.fn(),
  },
  replace: vi.fn(),
}));

vi.mock("@/components/auth-provider", () => ({ useAuth: () => auth }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useParams: () => ({ orgId: "org1" }),
  usePathname: () => "/org1/settings",
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
  replace.mockReset();
  Object.assign(auth, {
    user: { id: "u1" },
    isAuthLoading: false,
    orgMembership: { role: "member" },
    actor: "org-member",
    accessReadError: null,
  });
  auth.retryAccessReads.mockReset();
});

describe("ProtectedRoute", () => {
  it("sends a signed-out reader to sign in, to return here, and renders nothing", () => {
    window.history.replaceState(null, "", "/org1/settings?tab=a");
    auth.user = null;
    const { container } = renderGate({ requireOrgAccess: true });

    expect(replace).toHaveBeenCalledWith(
      "/sign-in?next=%2Forg1%2Fsettings%3Ftab%3Da",
    );
    expect(container).toBeEmptyDOMElement();
    window.history.replaceState(null, "", "/");
  });

  // A session read that never landed says nothing about the session (#1204).
  it("offers a retry, not sign-in, when the session read fails", () => {
    Object.assign(auth, { user: null, accessReadError: { status: 500 } });
    renderGate({});

    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByText("Couldn't load")).toBeInTheDocument();
    expect(screen.queryByText("Secret page")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(auth.retryAccessReads).toHaveBeenCalled();
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
      props: { requireOrgAdmin: true },
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
    expect(screen.queryByText("Secret page")).not.toBeInTheDocument();
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

  // The gate only decides once the session has resolved, and the page must
  // not mount and fire reads before then.
  it("holds the page back while the session is still resolving", () => {
    Object.assign(auth, { user: null, isAuthLoading: true });
    renderGate({ requireSuperAdmin: true });

    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
    expect(screen.queryByText("Secret page")).not.toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("keeps an admitted page up through a later read", () => {
    const { rerender } = renderGate({ requireOrgAccess: true });
    auth.isAuthLoading = true;
    rerender(
      <ProtectedRoute requireOrgAccess>
        <p>Secret page</p>
      </ProtectedRoute>,
    );

    expect(screen.getByText("Secret page")).toBeInTheDocument();
  });
});

describe("ProtectedRoute when an access read fails", () => {
  it.each([
    {
      name: "the membership",
      state: { actor: "org-member", orgMembership: null },
      props: { requireOrgAccess: true },
      denial: "Organization Access Required",
    },
    {
      name: "the Workspace",
      state: { actor: "org-member", orgMembership: { role: "member" } },
      props: { requireOrgAccess: true, requireWorkspaceAccess: true },
      denial: "Workspace Access Required",
    },
  ])(
    "offers a retry when $name read fails, not an access denial",
    ({ state, props, denial }) => {
      Object.assign(auth, state, { accessReadError: { status: 500 } });
      renderGate(props);

      expect(screen.getByText("Couldn't load")).toBeInTheDocument();
      expect(screen.queryByText(denial)).not.toBeInTheDocument();
      expect(screen.queryByText("Secret page")).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(auth.retryAccessReads).toHaveBeenCalled();
    },
  );

  // A failed read only matters where it would have turned the caller away.
  it("lets in a caller the gate admits anyway", () => {
    Object.assign(auth, {
      actor: "operator",
      orgMembership: null,
      accessReadError: { status: 500 },
    });
    renderGate({ requireOrgAccess: true });

    expect(screen.getByText("Secret page")).toBeInTheDocument();
  });
});
