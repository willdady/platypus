import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import {
  authMock,
  authState,
  swrMock,
  mockScopedSWR,
  mutate,
  resetListHarness,
  renderList,
  stubAcceptedSave,
  stubRejectedSave,
  stubSaveSequence,
  toastError,
  toastSuccess,
} from "@/test/list-test-harness";
import { savedBody } from "@/test/form-test-harness";

// --- Module mocks ------------------------------------------------------------

vi.mock("@/components/auth-provider", () => authMock);
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
  mockScopedSWR(
    {
      "/sandbox-backends/networks": networks,
      "/sandbox-backends": backends,
      "/ws1/sandbox": sandbox,
    },
    { strict: true },
  );
}

function renderSettings() {
  return renderList(<SandboxSettings orgId="org1" workspaceId="ws1" />);
}

const SANDBOX_URL = "http://test/organizations/org1/workspaces/ws1/sandbox";

function save() {
  return fireEvent.click(screen.getByRole("button", { name: "Save" }));
}

beforeEach(resetListHarness);

// --- Tests -------------------------------------------------------------------

describe("SandboxSettings loading", () => {
  it("shows the form's placeholder while the sandbox read loads", async () => {
    mockReads({ sandbox: { isLoading: true } });
    await renderSettings();

    expect(screen.getByLabelText("Loading sandbox")).toBeInTheDocument();
    expect(screen.queryByText("No sandbox configured")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  });

  it("shows the placeholder while the backends read loads", async () => {
    mockReads({ sandbox: { data: null }, backends: { isLoading: true } });
    await renderSettings();

    expect(screen.getByLabelText("Loading sandbox")).toBeInTheDocument();
  });

  it("shows a networks placeholder, not a false 'none declared', while the allowlist loads", async () => {
    mockReads({
      sandbox: { data: DOCKER_SANDBOX },
      networks: { isLoading: true },
    });
    await renderSettings();

    expect(screen.getByLabelText("Loading networks")).toBeInTheDocument();
    expect(
      screen.queryByText("No networks declared by the operator."),
    ).not.toBeInTheDocument();
  });

  it("says no networks are declared once the empty allowlist loads", async () => {
    mockReads({ sandbox: { data: DOCKER_SANDBOX } });
    await renderSettings();

    expect(
      screen.getByText("No networks declared by the operator."),
    ).toBeInTheDocument();
  });

  it("shows the Empty card once loaded with no sandbox", async () => {
    authState.actor = "member";
    mockReads({ sandbox: { data: null } });
    await renderSettings();

    expect(screen.getByText("No sandbox configured")).toBeInTheDocument();
  });
});

describe("SandboxSettings save", () => {
  it("creates the first sandbox on the first registered backend", async () => {
    const fetchMock = stubAcceptedSave({});
    mockReads({ sandbox: { data: null } });
    await renderSettings();

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
    await renderSettings();

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
    await renderSettings();

    expect(
      screen.queryByText("Admin environment variables"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Networks")).not.toBeInTheDocument();
    expect(
      screen.getByText("Managed by admin (read-only):"),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("SECRET")).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: /Delete/ }),
    ).not.toBeInTheDocument();

    save();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedBody(fetchMock)).toEqual({
      name: "Dev box",
      backend: "docker",
      userEnv: {},
    });
  });

  it("refuses to save a duplicate env key", async () => {
    authState.actor = "workspace-owner";
    const fetchMock = stubAcceptedSave({});
    mockReads({
      sandbox: { data: { ...DOCKER_SANDBOX, userEnv: { FOO: "1" } } },
    });
    await renderSettings();

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
    const renderSsh = async (sandbox: object = SSH_SANDBOX) => {
      mockReads({
        sandbox: { data: sandbox },
        backends: [{ backend: "ssh", name: "SSH" }],
      });
      await renderSettings();
    };
    const passphrase = () => screen.getByLabelText("Key passphrase (optional)");

    it("shows a stored key as stored, and keeps it on a save that leaves it alone", async () => {
      const fetchMock = stubAcceptedSave({});
      await renderSsh();

      expect(screen.getByText("Key stored")).toBeInTheDocument();
      expect(screen.queryByLabelText("Private key")).not.toBeInTheDocument();
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

    it("shows a plain key field, with no stored state, when no key is stored", async () => {
      await renderSsh({ ...SSH_SANDBOX, hasCredentials: false });

      expect(screen.getByLabelText("Private key")).toHaveValue("");
      expect(screen.queryByText("Key stored")).not.toBeInTheDocument();
      expect(screen.queryByText(/Leave blank to keep/)).not.toBeInTheDocument();
    });

    it("reveals the key field on Replace key, still keeping the stored key if left blank", async () => {
      const fetchMock = stubAcceptedSave({});
      await renderSsh();

      fireEvent.click(screen.getByRole("button", { name: "Replace key" }));
      expect(screen.queryByText("Key stored")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Private key")).toHaveValue("");
      save();

      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(savedBody(fetchMock)).not.toHaveProperty("credentials");
    });

    it("enables the passphrase only while a new key is entered, clearing it with the key", async () => {
      await renderSsh({ ...SSH_SANDBOX, hasCredentials: false });

      expect(passphrase()).toBeDisabled();
      fireEvent.change(screen.getByLabelText("Private key"), {
        target: { value: "-----KEY-----" },
      });
      expect(passphrase()).toBeEnabled();
      fireEvent.change(passphrase(), { target: { value: "pw" } });
      fireEvent.change(screen.getByLabelText("Private key"), {
        target: { value: "  " },
      });
      expect(passphrase()).toBeDisabled();
      expect(passphrase()).toHaveValue("");
    });

    it("sends a replacement key with its passphrase and optional pins", async () => {
      const fetchMock = stubAcceptedSave({});
      await renderSsh();

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
        status: 502,
        body: { error: "Teardown failed, retry with force=true" },
      },
      { status: 200, body: {} },
    );
    mockReads({ sandbox: { data: DOCKER_SANDBOX } });
    await renderSettings();

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

describe("SandboxSettings delete", () => {
  const openDelete = async () => {
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    return screen.findByRole("dialog");
  };

  it("keeps a refused delete in the dialog with the backend's message", async () => {
    stubRejectedSave("Sandbox is busy", 409);
    mockReads({ sandbox: { data: DOCKER_SANDBOX } });
    await renderSettings();

    const dialog = await openDelete();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(await within(dialog).findByText("Sandbox is busy")).toBeVisible();
    expect(toastError).not.toHaveBeenCalled();
  });

  // Destroying the sandbox can fail the same way a teardown does, and the
  // backend again asks for `force=true`.
  it("offers a forced delete when destroying the sandbox fails", async () => {
    const fetchMock = stubSaveSequence(
      {
        status: 502,
        body: { error: "Destroy failed, retry with force=true" },
      },
      { status: 200, body: {} },
    );
    mockReads({ sandbox: { data: DOCKER_SANDBOX } });
    await renderSettings();

    const dialog = await openDelete();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete anyway" }),
    );

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Sandbox deleted"),
    );
    expect(
      fetchMock.mock.calls.map(([url, init]) => [url, init.method]),
    ).toEqual([
      [SANDBOX_URL, "DELETE"],
      [`${SANDBOX_URL}?force=true`, "DELETE"],
    ]);
    expect(mutate).toHaveBeenCalledWith(null, { revalidate: false });
  });
});

describe("SandboxSettings revalidation", () => {
  it("keeps an unsaved edit when the same sandbox revalidates", async () => {
    authState.actor = "org-admin";
    mockReads({ sandbox: { data: DOCKER_SANDBOX } });
    const { rerender } = await renderSettings();

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Edited box" },
    });
    mockReads({ sandbox: { data: { ...DOCKER_SANDBOX } } });
    rerender(<SandboxSettings orgId="org1" workspaceId="ws1" />);

    expect(screen.getByLabelText("Name")).toHaveValue("Edited box");
  });
});
