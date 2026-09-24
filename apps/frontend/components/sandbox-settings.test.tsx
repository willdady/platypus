import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import {
  authMock,
  authState,
  swrMock,
  toastMock,
  mockScopedSWR,
  resetListHarness,
  renderList,
} from "@/lib/list-test-harness";

// --- Module mocks ------------------------------------------------------------

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("sonner", () => toastMock);
vi.mock("swr", () => swrMock);

import { SandboxSettings } from "./sandbox-settings";

// --- Helpers -----------------------------------------------------------------

const DOCKER_SANDBOX = {
  id: "sb1",
  workspaceId: "ws1",
  name: "Dev box",
  backend: "docker",
  config: {},
  adminEnv: {},
  userEnv: {},
};

/**
 * Registers the sandbox's three reads. The backends and networks fragments go
 * first: matching is by URL fragment in registration order, and both URLs
 * also contain `/sandbox`.
 */
function mockReads({
  sandbox,
  backends = [{ backend: "docker", name: "Docker" }],
  networks = [],
}: {
  sandbox: Parameters<typeof mockScopedSWR>[0][string];
  backends?: Parameters<typeof mockScopedSWR>[0][string];
  networks?: Parameters<typeof mockScopedSWR>[0][string];
}) {
  mockScopedSWR({
    "/sandbox/backends": backends,
    "/sandbox/networks": networks,
    "/sandbox": sandbox,
  });
}

const renderSettings = () =>
  renderList(<SandboxSettings orgId="org1" workspaceId="ws1" />);

beforeEach(resetListHarness);

// --- Tests -------------------------------------------------------------------

describe("SandboxSettings loading", () => {
  it("shows the form's placeholder while the sandbox read loads", () => {
    mockReads({ sandbox: { isLoading: true } });
    renderSettings();

    expect(screen.getByLabelText("Loading sandbox")).toBeInTheDocument();
    expect(screen.queryByText("No sandbox configured")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  });

  it("shows the placeholder while the backends read loads", () => {
    mockReads({ sandbox: { data: null }, backends: { isLoading: true } });
    renderSettings();

    expect(screen.getByLabelText("Loading sandbox")).toBeInTheDocument();
  });

  it("shows a networks placeholder, not a false 'none declared', while the allowlist loads", () => {
    mockReads({
      sandbox: { data: DOCKER_SANDBOX },
      networks: { isLoading: true },
    });
    renderSettings();

    expect(screen.getByLabelText("Loading networks")).toBeInTheDocument();
    expect(
      screen.queryByText("No networks declared by the operator."),
    ).not.toBeInTheDocument();
  });

  it("says no networks are declared once the empty allowlist loads", () => {
    mockReads({ sandbox: { data: DOCKER_SANDBOX } });
    renderSettings();

    expect(
      screen.getByText("No networks declared by the operator."),
    ).toBeInTheDocument();
  });

  it("shows the Empty card once loaded with no sandbox", () => {
    authState.actor = "member";
    mockReads({ sandbox: { data: null } });
    renderSettings();

    expect(screen.getByText("No sandbox configured")).toBeInTheDocument();
  });
});
