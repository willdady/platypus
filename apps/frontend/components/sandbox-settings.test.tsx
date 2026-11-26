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
  setupUser,
  toastError,
  toastSuccess,
} from "@/test/list-test-harness";
import { selectOption } from "@/test/test-utils";
import { sandboxCreateSchema, sandboxUpdateSchema } from "@platypus/schemas";
import { expectSentBodyToMatchSchema } from "@/test/test-utils";
import type { WriteOutcome } from "@/lib/api-write";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("swr", () => swrMock);

import { SandboxSettings } from "./sandbox-settings";

function savedSandboxBody(
  fetchMock: ReturnType<typeof vi.fn>,
  schema = sandboxUpdateSchema,
) {
  return expectSentBodyToMatchSchema(fetchMock, schema);
}

type FetchCall = [url: string, init: RequestInit];

function fetchCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls as FetchCall[];
}

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

function mockReads({
  sandbox,
  backends = [{ backend: "docker", name: "Docker" }],
  networks = [],
}: {
  sandbox: Parameters<typeof mockScopedSWR>[0][string];
  backends?: Parameters<typeof mockScopedSWR>[0][string];
  networks?: Parameters<typeof mockScopedSWR>[0][string];
}) {
  // why: URLs match by fragment in order, so networks goes before backends
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

describe("SandboxSettings loading", () => {
  it("shows the form's placeholder while the sandbox read loads", async () => {
    mockReads({ sandbox: { isLoading: true } });
    await renderSettings();

    expect(
      screen.getByRole("status", { name: "Loading sandbox" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("No sandbox configured")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  });

  it("shows the placeholder while the backends read loads", async () => {
    mockReads({ sandbox: { data: null }, backends: { isLoading: true } });
    await renderSettings();

    expect(
      screen.getByRole("status", { name: "Loading sandbox" }),
    ).toBeInTheDocument();
  });

  it("shows a networks placeholder, not a false 'none declared', while the allowlist loads", async () => {
    mockReads({
      sandbox: { data: DOCKER_SANDBOX },
      networks: { isLoading: true },
    });
    await renderSettings();

    expect(
      screen.getByRole("status", { name: "Loading networks" }),
    ).toBeInTheDocument();
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

describe("SandboxSettings secondary reads", () => {
  it("shows the backends read failure instead of claiming none are registered", async () => {
    mockReads({
      sandbox: { data: null },
      backends: { error: new Error("500") },
    });
    await renderSettings();

    expect(
      screen.getByText(/Failed to load sandbox backends/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(
      screen.queryByText(/No sandbox backends are registered/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("No sandbox configured")).not.toBeInTheDocument();
  });

  it("still says none are registered once the backends list has loaded empty", async () => {
    authState.actor = "org-admin";
    mockReads({ sandbox: { data: null }, backends: [] });
    await renderSettings();

    expect(
      screen.getByText(/No sandbox backends are registered/),
    ).toBeInTheDocument();
  });

  it("shows the networks read failure instead of claiming none are declared", async () => {
    mockReads({
      sandbox: { data: DOCKER_SANDBOX },
      networks: { error: new Error("500") },
    });
    await renderSettings();

    expect(screen.getByText(/Failed to load networks/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(
      screen.queryByText("No networks declared by the operator."),
    ).not.toBeInTheDocument();
  });
});

describe("SandboxSettings read failure", () => {
  it("shows a cold read failure with a retry, not the form", async () => {
    mockReads({ sandbox: { error: { status: 500, message: "Server error" } } });
    await renderSettings();

    expect(screen.getByText("Couldn't load sandbox")).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mutate).toHaveBeenCalled();
  });

  it("keeps the form when a revalidation fails over loaded data", async () => {
    mockReads({
      sandbox: {
        data: DOCKER_SANDBOX,
        error: { status: 500, message: "Server error" },
      },
    });
    await renderSettings();

    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load sandbox")).not.toBeInTheDocument();
  });
});

describe("SandboxSettings draft", () => {
  it("says Saving... while the wizard collects the sandbox", async () => {
    let finishWrite: (outcome: WriteOutcome<undefined>) => void = () => {};
    const write = vi.fn(
      () =>
        new Promise<WriteOutcome<undefined>>((resolve) => {
          finishWrite = resolve;
        }),
    );
    mockReads({ sandbox: { data: null } });
    await renderList(
      <SandboxSettings
        orgId="org1"
        draft={{ write, onBack: vi.fn(), submitText: "Save" }}
      />,
    );

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Dev box" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();

    finishWrite({ outcome: "success", data: undefined, revalidateKeys: [] });
  });
});

describe("SandboxSettings save", () => {
  it("saves on Enter in the Name field", async () => {
    const fetchMock = stubAcceptedSave({});
    mockReads({ sandbox: { data: DOCKER_SANDBOX } });
    await renderSettings();

    const name = screen.getByLabelText("Name");
    fireEvent.change(name, { target: { value: "Edited box" } });
    await setupUser().type(name, "{Enter}");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(savedSandboxBody(fetchMock)).toMatchObject({ name: "Edited box" });
  });

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
    expect(savedSandboxBody(fetchMock, sandboxCreateSchema)).toEqual({
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
    expect(savedSandboxBody(fetchMock)).toEqual({
      name: "Dev box",
      backend: "docker",
      config: { networks: ["bridge-a"], extraHosts: ["v6:::1"] },
      credentials: {},
      adminEnv: { SECRET: "s" },
      userEnv: { FOO: "1" },
    });
  });

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
    expect(savedSandboxBody(fetchMock)).toEqual({
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
      expect(savedSandboxBody(fetchMock)).toEqual({
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
      expect(savedSandboxBody(fetchMock)).not.toHaveProperty("credentials");
    });

    it("shows a config rejection beside the field the backend names", async () => {
      stubRejectedSave(
        [{ path: ["config", "host"], message: "Host is unreachable" }],
        400,
      );
      await renderSsh();

      save();

      expect(await screen.findByText("Host is unreachable")).toBeVisible();
      expect(screen.getByLabelText("Host")).toHaveAttribute(
        "aria-invalid",
        "true",
      );
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
      expect(savedSandboxBody(fetchMock)).toMatchObject({
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
    expect(fetchCalls(fetchMock).map(([url]) => url)).toEqual([
      SANDBOX_URL,
      `${SANDBOX_URL}?force=true`,
    ]);
  });

  it("keeps a refused forced switch open with the backend's message, then retries", async () => {
    stubSaveSequence(
      {
        status: 502,
        body: { error: "Teardown failed, retry with force=true" },
      },
      { status: 409, body: { error: "Sandbox backend is busy" } },
      { status: 200, body: {} },
    );
    mockReads({ sandbox: { data: DOCKER_SANDBOX } });
    await renderSettings();

    save();
    fireEvent.click(
      await screen.findByRole("button", { name: "Switch anyway" }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByText("Sandbox backend is busy"),
    ).toBeVisible();
    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Switch anyway" }),
    );

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Sandbox configured"),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("SandboxSettings backend fields", () => {
  it("shows the chosen backend's fields, keeping what the other one holds", async () => {
    mockReads({
      sandbox: { data: DOCKER_SANDBOX },
      backends: [
        { backend: "docker", name: "Docker" },
        { backend: "ssh", name: "SSH" },
      ],
    });
    await renderSettings();

    const backend = () => screen.getByRole("combobox", { name: "Backend" });

    fireEvent.click(screen.getByRole("button", { name: "Add host" }));
    fireEvent.change(screen.getByLabelText("hostname 1"), {
      target: { value: "db" },
    });
    expect(screen.queryByLabelText("Host")).not.toBeInTheDocument();

    await selectOption(backend(), "SSH");
    expect(
      screen.queryByRole("button", { name: "Add host" }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Host"), {
      target: { value: "ssh.example.com" },
    });

    await selectOption(backend(), "Docker");
    expect(screen.getByLabelText("hostname 1")).toHaveValue("db");

    await selectOption(backend(), "SSH");
    expect(screen.getByLabelText("Host")).toHaveValue("ssh.example.com");
  });
});

describe("SandboxSettings generated backend form", () => {
  const CLOUD_BACKEND = {
    backend: "test-cloud",
    name: "Test Cloud",
    configSchema: {
      type: "object",
      properties: {
        region: { type: "string", title: "Region" },
        replicas: { type: "integer", default: 2 },
        warm: { type: "boolean" },
        tier: { type: "string", enum: ["standard", "fast"] },
      },
      required: ["region"],
    },
    credentialsSchema: {
      type: "object",
      properties: { apiToken: { type: "string", title: "API token" } },
      required: ["apiToken"],
    },
  };

  const CLOUD_SANDBOX = {
    ...DOCKER_SANDBOX,
    backend: "test-cloud",
    config: { region: "us" },
    hasCredentials: true,
  };

  const renderCloud = async (sandbox: object | null = null) => {
    mockReads({
      sandbox: { data: sandbox },
      backends: [CLOUD_BACKEND],
    });
    await renderSettings();
  };

  it("creates with config and credentials typed from the schema", async () => {
    const fetchMock = stubAcceptedSave({});
    await renderCloud();

    fireEvent.click(screen.getByRole("button", { name: /Configure sandbox/ }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Dev box" },
    });
    fireEvent.change(screen.getByLabelText("Region"), {
      target: { value: "eu-west" },
    });
    fireEvent.change(screen.getByLabelText("Replicas"), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByRole("switch", { name: "Warm" }));
    await selectOption(screen.getByRole("combobox", { name: "Tier" }), "fast");
    fireEvent.change(screen.getByLabelText("API token"), {
      target: { value: "tok-123" },
    });
    save();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedSandboxBody(fetchMock, sandboxCreateSchema)).toEqual({
      workspaceId: "ws1",
      name: "Dev box",
      backend: "test-cloud",
      config: { region: "eu-west", replicas: 3, warm: true, tier: "fast" },
      credentials: { apiToken: "tok-123" },
      adminEnv: {},
      userEnv: {},
    });
  });

  it("masks credentials and shows a stored one without returning it", async () => {
    await renderCloud(CLOUD_SANDBOX);

    const token = screen.getByLabelText("API token");
    expect(token).toHaveAttribute("type", "password");
    expect(token).toHaveValue("");
    expect(token).toHaveAttribute("placeholder", "Stored");
    expect(screen.getByText(/Leave every field blank to keep/)).toBeVisible();
    expect(screen.getByLabelText("Region")).toHaveValue("us");
  });

  it("keeps a stored credential when an edit leaves it blank", async () => {
    const fetchMock = stubAcceptedSave({});
    await renderCloud(CLOUD_SANDBOX);

    fireEvent.change(screen.getByLabelText("Region"), {
      target: { value: "eu-west" },
    });
    save();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedSandboxBody(fetchMock)).toEqual({
      name: "Dev box",
      backend: "test-cloud",
      config: { region: "eu-west" },
      adminEnv: {},
      userEnv: {},
    });
  });

  it("sends a replacement credential when one is entered", async () => {
    const fetchMock = stubAcceptedSave({});
    await renderCloud(CLOUD_SANDBOX);

    fireEvent.change(screen.getByLabelText("API token"), {
      target: { value: "tok-456" },
    });
    save();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedSandboxBody(fetchMock)).toMatchObject({
      credentials: { apiToken: "tok-456" },
    });
  });

  it("shows a required field's rejection beside the field", async () => {
    stubRejectedSave(
      [{ path: ["config", "region"], message: "Region is required" }],
      400,
    );
    await renderCloud();

    fireEvent.click(screen.getByRole("button", { name: /Configure sandbox/ }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Dev box" },
    });
    fireEvent.change(screen.getByLabelText("API token"), {
      target: { value: "tok-123" },
    });
    save();

    expect(await screen.findByText("Region is required")).toBeVisible();
    expect(screen.getByLabelText("Region")).toHaveAttribute(
      "aria-invalid",
      "true",
    );

    fireEvent.change(screen.getByLabelText("Region"), {
      target: { value: "eu-west" },
    });
    expect(screen.queryByText("Region is required")).not.toBeInTheDocument();
  });

  it("shows a credentials rejection beside the field", async () => {
    stubRejectedSave(
      [{ path: ["credentials", "apiToken"], message: "Token was rejected" }],
      400,
    );
    await renderCloud();

    fireEvent.click(screen.getByRole("button", { name: /Configure sandbox/ }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Dev box" },
    });
    fireEvent.change(screen.getByLabelText("Region"), {
      target: { value: "eu-west" },
    });
    save();

    expect(await screen.findByText("Token was rejected")).toBeVisible();
    expect(screen.getByLabelText("API token")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("restores the saved backend's config when switched back", async () => {
    mockReads({
      sandbox: { data: CLOUD_SANDBOX },
      backends: [CLOUD_BACKEND, { backend: "ssh", name: "SSH" }],
    });
    await renderSettings();

    const backend = screen.getByRole("combobox", { name: "Backend" });
    await selectOption(backend, "SSH");
    await selectOption(backend, "Test Cloud");

    expect(screen.getByLabelText("Region")).toHaveValue("us");
  });

  it("drops a backend's generated values when the backend changes", async () => {
    mockReads({
      sandbox: { data: CLOUD_SANDBOX },
      backends: [CLOUD_BACKEND, { backend: "ssh", name: "SSH" }],
    });
    await renderSettings();

    await selectOption(
      screen.getByRole("combobox", { name: "Backend" }),
      "SSH",
    );
    expect(screen.queryByLabelText("Region")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Host")).toHaveValue("");
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
      fetchCalls(fetchMock).map(([url, init]) => [url, init.method]),
    ).toEqual([
      [SANDBOX_URL, "DELETE"],
      [`${SANDBOX_URL}?force=true`, "DELETE"],
    ]);
    expect(mutate).toHaveBeenCalledWith(null, { revalidate: false });
  });

  it("keeps a refused forced delete open with the backend's message", async () => {
    stubSaveSequence(
      {
        status: 502,
        body: { error: "Destroy failed, retry with force=true" },
      },
      { status: 409, body: { error: "Sandbox is still running" } },
    );
    mockReads({ sandbox: { data: DOCKER_SANDBOX } });
    await renderSettings();

    const deleteDialog = await openDelete();
    fireEvent.click(
      within(deleteDialog).getByRole("button", { name: "Delete" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete anyway" }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByText("Sandbox is still running"),
    ).toBeVisible();
    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
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

describe("SandboxSettings field wiring", () => {
  const SSH_SANDBOX = {
    ...DOCKER_SANDBOX,
    backend: "ssh",
    config: {},
    hasCredentials: false,
  };

  it("describes the fields that carry help text", async () => {
    mockReads({
      sandbox: { data: SSH_SANDBOX },
      backends: [{ backend: "ssh", name: "SSH" }],
    });
    await renderSettings();

    expect(screen.getByLabelText("Backend")).toHaveAccessibleDescription(
      "The runtime that hosts the sandbox environment.",
    );
    expect(screen.getByLabelText("Host")).toHaveAccessibleDescription(
      "Hostname or IP of the operator-owned host to attach to.",
    );
    expect(
      screen.getByLabelText("Host key (optional)"),
    ).toHaveAccessibleDescription(/Pin the host's public key/);
    expect(screen.getByLabelText("Private key")).toHaveAccessibleDescription(
      /PEM or OpenSSH private key/,
    );
    expect(
      screen.getByLabelText("Key passphrase (optional)"),
    ).toHaveAccessibleDescription(/Enter a private key first/);
  });

  it("clears the config error when a Docker config field is edited", async () => {
    stubRejectedSave(
      [{ path: ["config", "extraHosts"], message: "Invalid extra host" }],
      400,
    );
    mockReads({ sandbox: { data: DOCKER_SANDBOX }, networks: ["bridge-a"] });
    await renderSettings();

    save();
    expect(await screen.findByText("Invalid extra host")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("switch", { name: "Attach network bridge-a" }),
    );

    expect(screen.queryByText("Invalid extra host")).not.toBeInTheDocument();
  });

  it("clears a network's own error when the allowlist is edited", async () => {
    stubRejectedSave(
      [{ path: ["config", "networks"], message: "Unknown network" }],
      400,
    );
    mockReads({ sandbox: { data: DOCKER_SANDBOX }, networks: ["bridge-a"] });
    await renderSettings();

    save();
    expect(await screen.findByText("Unknown network")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("switch", { name: "Attach network bridge-a" }),
    );

    expect(screen.queryByText("Unknown network")).not.toBeInTheDocument();
  });

  it("marks a refused field invalid and describes it with the error", async () => {
    stubRejectedSave([{ path: ["name"], message: "Name is taken" }], 400);
    mockReads({ sandbox: { data: DOCKER_SANDBOX } });
    await renderSettings();

    const name = screen.getByLabelText("Name");
    save();

    await waitFor(() => expect(name).toHaveAttribute("aria-invalid", "true"));
    expect(name).toHaveAccessibleDescription("Name is taken");
  });
});
