import { beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";

// A fake of the one Daytona sandbox this suite provisions. `exec` decides how a
// session command answers; everything else records what the adapter asked for.
const fake = vi.hoisted(() => {
  const state = {
    exists: false,
    sandboxState: "started" as string,
    commands: [] as string[],
    deletedSessions: [] as string[],
    uploads: [] as { path: string; bytes: Buffer }[],
    files: new Map<string, Buffer>(),
    deleted: 0,
    exec: (
      command: string,
    ): Promise<{ exitCode?: number; stdout?: string; stderr?: string }> => {
      if (command.includes("pwd"))
        return Promise.resolve({
          exitCode: 0,
          stdout: "/home/daytona/workspace\n",
        });
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    },
  };
  class DaytonaNotFoundError extends Error {}
  class DaytonaConflictError extends Error {}
  const sandbox = {
    get state() {
      return state.sandboxState;
    },
    start: vi.fn(() => {
      state.sandboxState = "started";
      return Promise.resolve();
    }),
    waitUntilStarted: vi.fn(() => Promise.resolve()),
    delete: vi.fn(() => {
      state.deleted++;
      state.exists = false;
      return Promise.resolve();
    }),
    process: {
      createSession: vi.fn(() => Promise.resolve()),
      executeSessionCommand: vi.fn((_id: string, req: { command: string }) => {
        state.commands.push(req.command);
        return state.exec(req.command);
      }),
      deleteSession: vi.fn((id: string) => {
        state.deletedSessions.push(id);
        return Promise.resolve();
      }),
    },
    fs: {
      downloadFileStream: vi.fn((path: string) => {
        const file = state.files.get(path);
        if (!file) return Promise.reject(new Error("no such file"));
        return Promise.resolve(Readable.from([file]));
      }),
      uploadFile: vi.fn((bytes: Buffer, path: string) => {
        state.uploads.push({ path, bytes });
        return Promise.resolve();
      }),
    },
  };
  const daytona = {
    get: vi.fn(() =>
      state.exists
        ? Promise.resolve(sandbox)
        : Promise.reject(new DaytonaNotFoundError("not found")),
    ),
    create: vi.fn(() => {
      state.exists = true;
      return Promise.resolve(sandbox);
    }),
  };
  return {
    state,
    sandbox,
    daytona,
    DaytonaNotFoundError,
    DaytonaConflictError,
  };
});

vi.mock("@daytonaio/sdk", () => ({
  Daytona: vi.fn(function () {
    return fake.daytona;
  }),
  DaytonaNotFoundError: fake.DaytonaNotFoundError,
  DaytonaConflictError: fake.DaytonaConflictError,
  SandboxState: { STARTED: "started", STARTING: "starting" },
}));

import { createDaytonaSandboxBackend } from "./backend.ts";
import { makeFakePluginLogger } from "../../test-utils.ts";
import type { SandboxContext } from "../../sandbox/types.ts";

const ctx: SandboxContext = {
  orgId: "org-1",
  workspaceId: "ws-abc",
  userId: "user-1",
};
const callOptions = { signal: new AbortController().signal };

const makeBackend = (
  config: Record<string, unknown> = {},
  credentials: Record<string, unknown> = {},
) =>
  createDaytonaSandboxBackend({
    config,
    credentials: { apiKey: "dtn_test", ...credentials },
    logger: makeFakePluginLogger(),
  });

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(fake.state, {
    exists: false,
    sandboxState: "started",
    commands: [],
    deletedSessions: [],
    uploads: [],
    files: new Map(),
    deleted: 0,
  });
});

describe("Daytona sandbox backend", () => {
  it("creates the Workspace's sandbox once, under its name, from the configured snapshot", async () => {
    const backend = makeBackend({ snapshot: "my-snap", autoStopInterval: 5 });
    await Promise.all([
      backend.shellExec(ctx, { command: "true" }, callOptions),
      backend.shellExec(ctx, { command: "true" }, callOptions),
    ]);

    expect(fake.daytona.create).toHaveBeenCalledTimes(1);
    expect(fake.daytona.create).toHaveBeenCalledWith({
      name: "platypus-org-1-ws-abc",
      snapshot: "my-snap",
      labels: { "platypus.sandbox.workspaceId": "ws-abc" },
      autoStopInterval: 5,
    });
  });

  it("creates the sandbox with the Operator's network policy", async () => {
    await makeBackend(
      {
        networkBlockAll: false,
        networkAllowList: ["10.0.0.0/8", "192.168.1.0/24"],
        domainAllowList: ["github.com", "pypi.org"],
      },
      { outboundProxyUrl: "http://user:pw@proxy.internal:3128" },
    ).shellExec(ctx, { command: "true" }, callOptions);

    expect(fake.daytona.create).toHaveBeenCalledWith(
      expect.objectContaining({
        networkBlockAll: false,
        networkAllowList: "10.0.0.0/8,192.168.1.0/24",
        domainAllowList: "github.com,pypi.org",
        outboundProxyUrl: "http://user:pw@proxy.internal:3128",
      }),
    );
  });

  it("rejects an allowlist entry that would split on Daytona's comma join", () => {
    expect(() =>
      makeBackend({ domainAllowList: ["github.com,evil.com"] }),
    ).toThrow(/comma/);
  });

  it("starts a stopped sandbox it finds", async () => {
    fake.state.exists = true;
    fake.state.sandboxState = "stopped";
    await makeBackend().shellExec(ctx, { command: "true" }, callOptions);

    expect(fake.daytona.create).not.toHaveBeenCalled();
    expect(fake.sandbox.start).toHaveBeenCalledTimes(1);
  });

  it("runs the command in the workspace root, keeps stdout and stderr apart, and deletes the session", async () => {
    fake.state.exec = (command) =>
      Promise.resolve(
        command.includes("pwd")
          ? { exitCode: 0, stdout: "/home/daytona/workspace\n" }
          : { exitCode: 3, stdout: "out", stderr: "err" },
      );
    const res = await makeBackend().shellExec(
      ctx,
      { command: "echo hi", cwd: "src" },
      callOptions,
    );

    expect(res).toMatchObject({ stdout: "out", stderr: "err", exitCode: 3 });
    expect(fake.state.commands.at(-1)).toContain(
      "cd '/home/daytona/workspace/src' && ",
    );
    expect(fake.state.deletedSessions).toHaveLength(2);
  });

  it("reports a command that outruns its timeout as exit 124", async () => {
    fake.state.exec = (command) =>
      command.includes("pwd")
        ? Promise.resolve({ exitCode: 0, stdout: "/home/daytona/workspace" })
        : new Promise(() => {});
    const res = await makeBackend().shellExec(
      ctx,
      { command: "sleep 100", timeoutMs: 20 },
      callOptions,
    );

    expect(res.exitCode).toBe(124);
  });

  it("refuses to create a file that already exists", async () => {
    fake.state.exec = (command) =>
      Promise.resolve(
        command.includes("pwd")
          ? { exitCode: 0, stdout: "/home/daytona/workspace" }
          : { exitCode: command.includes("'create'") ? 17 : 0 },
      );
    const backend = makeBackend();

    await expect(
      backend.fsWrite(
        ctx,
        { path: "a.txt", content: "x", mode: "create" },
        callOptions,
      ),
    ).rejects.toThrow(/already exists/);
    expect(fake.state.uploads).toHaveLength(0);

    await backend.fsWrite(
      ctx,
      { path: "a.txt", content: "x", mode: "overwrite" },
      callOptions,
    );
    expect(fake.state.uploads).toEqual([
      { path: "/home/daytona/workspace/a.txt", bytes: Buffer.from("x") },
    ]);
  });

  it("reads a file through the download stream", async () => {
    fake.state.files.set(
      "/home/daytona/workspace/a.txt",
      Buffer.from("one\ntwo\n"),
    );
    const res = await makeBackend().fsRead(ctx, { path: "a.txt" }, callOptions);

    expect(res).toMatchObject({ content: "one\ntwo\n", truncated: false });
  });

  it("deletes the sandbox on destroy, and tolerates one already gone", async () => {
    fake.state.exists = true;
    const backend = makeBackend();
    await backend.destroy(ctx);
    await backend.destroy(ctx);

    expect(fake.state.deleted).toBe(1);
  });
});
