import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import {
  authMock,
  authState,
  swrMock,
  toastMock,
  mockScopedSWR,
  mutate,
  resetListHarness,
  renderList,
  stubAcceptedSave,
  stubSaveSequence,
  toastSuccess,
} from "@/lib/list-test-harness";
import { savedBody } from "@/lib/form-test-harness";

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
  hasCredentials: false,
};

/**
 * Registers the sandbox's three reads. Matching is by URL fragment in
 * registration order, so the networks fragment goes before the backends one it
 * contains.
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
    "/sandbox-backends/networks": networks,
    "/sandbox-backends": backends,
    "/ws1/sandbox": sandbox,
  });
}

const renderSettings = () =>
  renderList(<SandboxSettings orgId="org1" workspaceId="ws1" />);

const SANDBOX_URL = "http://test/organizations/org1/workspaces/ws1/sandbox";

const save = () =>
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

beforeEach(resetListHarness);
afterEach(() => vi.unstubAllGlobals());

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

describe("SandboxSettings save", () => {
  it("creates the first sandbox on the first registered backend", async () => {
    const fetchMock = stubAcceptedSave({});
    mockReads({ sandbox: { data: null } });
    renderSettings();

    fireEvent.click(screen.getByRole("button", { name: /Configure sandbox/ }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Dev box" },
    });
    save();

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Sandbox configured"),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      SANDBOX_URL,
      expect.objectContaining({ method: "POST" }),
    );
    expect(savedBody(fetchMock)).toEqual({
      workspaceId: "ws1",
      name: "Dev box",
      backend: "docker",
      config: { networks: [], extraHosts: [] },
      credentials: {},
      adminEnv: {},
      userEnv: {},
    });
    expect(mutate).toHaveBeenCalled();
  });

  it("sends an admin's docker reachability and both env tiers on an edit", async () => {
    const fetchMock = stubAcceptedSave({});
    mockReads({
      sandbox: {
        data: {
          ...DOCKER_SANDBOX,
          // Split on the first colon only, so an IPv6 target survives.
          config: { networks: [], extraHosts: ["v6:::1"] },
          adminEnv: { SECRET: "s" },
          userEnv: { FOO: "1" },
        },
      },
      networks: ["bridge-a"],
    });
    renderSettings();

    fireEvent.click(
      screen.getByRole("switch", { name: "Attach network bridge-a" }),
    );
    save();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      SANDBOX_URL,
      expect.objectContaining({ method: "PUT" }),
    );
    expect(savedBody(fetchMock)).toEqual({
      name: "Dev box",
      backend: "docker",
      config: { networks: ["bridge-a"], extraHosts: ["v6:::1"] },
      credentials: {},
      adminEnv: { SECRET: "s" },
      userEnv: { FOO: "1" },
    });
  });

  // ADR-0006: a Workspace owner manages only the name and their own env.
  it("sends a non-admin's name and env only, showing admin keys read-only", async () => {
    authState.actor = "workspace-owner";
    const fetchMock = stubAcceptedSave({});
    mockReads({
      sandbox: {
        data: { ...DOCKER_SANDBOX, adminEnv: { SECRET: "" }, userEnv: {} },
      },
    });
    renderSettings();

    expect(screen.queryByText("Admin environment variables")).toBeNull();
    expect(screen.queryByText("Networks")).toBeNull();
    expect(
      screen.getByText("Managed by admin (read-only):"),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("SECRET")).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Delete/ })).toBeNull();

    save();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedBody(fetchMock)).toEqual({
      name: "Dev box",
      backend: "docker",
      userEnv: {},
    });
  });

  it("refuses to save a duplicate env key", () => {
    authState.actor = "workspace-owner";
    const fetchMock = stubAcceptedSave({});
    mockReads({
      sandbox: { data: { ...DOCKER_SANDBOX, userEnv: { FOO: "1" } } },
    });
    renderSettings();

    fireEvent.click(screen.getByRole("button", { name: "Add variable" }));
    fireEvent.change(screen.getByLabelText("KEY 2"), {
      target: { value: " FOO " },
    });
    save();

    expect(screen.getByText("Duplicate env key: FOO")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ADR-0012: GET strips the SSH credentials and reports only whether some are
  // stored, so a stored key shows as "Key stored" and an edit that leaves it
  // alone must keep it rather than clear it (#1056).
  describe("SSH", () => {
    const SSH_SANDBOX = {
      ...DOCKER_SANDBOX,
      backend: "ssh",
      config: { host: "ssh.example.com", port: 2222, user: "platypus" },
      hasCredentials: true,
    };
    const renderSsh = (sandbox: object = SSH_SANDBOX) => {
      mockReads({
        sandbox: { data: sandbox },
        backends: [{ backend: "ssh", name: "SSH" }],
      });
      renderSettings();
    };
    const passphrase = () => screen.getByLabelText("Key passphrase (optional)");

    it("shows a stored key as stored, and keeps it on a save that leaves it alone", async () => {
      const fetchMock = stubAcceptedSave({});
      renderSsh();

      expect(screen.getByText("Key stored")).toBeInTheDocument();
      expect(screen.queryByLabelText("Private key")).toBeNull();
      save();

      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(savedBody(fetchMock)).toEqual({
        name: "Dev box",
        backend: "ssh",
        config: { host: "ssh.example.com", port: 2222, user: "platypus" },
        adminEnv: {},
        userEnv: {},
      });
    });

    it("shows a plain key field, with no stored state, when no key is stored", () => {
      renderSsh({ ...SSH_SANDBOX, hasCredentials: false });

      expect(screen.getByLabelText("Private key")).toHaveValue("");
      expect(screen.queryByText("Key stored")).toBeNull();
      expect(screen.queryByText(/Leave blank to keep/)).toBeNull();
    });

    it("reveals the key field on Replace key, still keeping the stored key if left blank", async () => {
      const fetchMock = stubAcceptedSave({});
      renderSsh();

      fireEvent.click(screen.getByRole("button", { name: "Replace key" }));
      expect(screen.queryByText("Key stored")).toBeNull();
      expect(screen.getByLabelText("Private key")).toHaveValue("");
      save();

      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(savedBody(fetchMock)).not.toHaveProperty("credentials");
    });

    it("enables the passphrase only while a new key is entered", () => {
      renderSsh({ ...SSH_SANDBOX, hasCredentials: false });

      expect(passphrase()).toBeDisabled();
      fireEvent.change(screen.getByLabelText("Private key"), {
        target: { value: "-----KEY-----" },
      });
      expect(passphrase()).toBeEnabled();
      fireEvent.change(screen.getByLabelText("Private key"), {
        target: { value: "  " },
      });
      expect(passphrase()).toBeDisabled();
    });

    it("sends a replacement key with its passphrase and optional pins", async () => {
      const fetchMock = stubAcceptedSave({});
      renderSsh();

      fireEvent.click(screen.getByRole("button", { name: "Replace key" }));
      fireEvent.change(screen.getByLabelText("Private key"), {
        target: { value: "-----KEY-----" },
      });
      fireEvent.change(passphrase(), { target: { value: "pw" } });
      fireEvent.change(screen.getByLabelText("Host key (optional)"), {
        target: { value: " ssh-ed25519 AAAA " },
      });
      fireEvent.change(screen.getByLabelText("Workspace root (optional)"), {
        target: { value: "/srv/box" },
      });
      save();

      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(savedBody(fetchMock)).toMatchObject({
        config: {
          host: "ssh.example.com",
          port: 2222,
          user: "platypus",
          rootDir: "/srv/box",
          hostKey: "ssh-ed25519 AAAA",
        },
        credentials: { privateKey: "-----KEY-----", passphrase: "pw" },
      });
    });
  });

  // A backend switch tears the old sandbox down first; when that fails the
  // backend asks for `force=true`, which the reader has to opt into.
  it("offers a forced switch when tearing down the previous sandbox fails", async () => {
    const fetchMock = stubSaveSequence(
      {
        status: 500,
        body: { error: "Teardown failed, retry with force=true" },
      },
      { status: 200, body: {} },
    );
    mockReads({ sandbox: { data: DOCKER_SANDBOX } });
    renderSettings();

    save();
    fireEvent.click(
      await screen.findByRole("button", { name: "Switch anyway" }),
    );

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Sandbox configured"),
    );
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      SANDBOX_URL,
      `${SANDBOX_URL}?force=true`,
    ]);
  });
});
