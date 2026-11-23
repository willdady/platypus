import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";
import { SANDBOX_TRANSFER_MAX_BYTES } from "@platypuschat/plugin-sdk";

type FakeContainer = {
  inspect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
  putArchive: ReturnType<typeof vi.fn>;
  modem: {
    demuxStream: (
      stream: PassThrough,
      stdout: PassThrough,
      stderr: PassThrough,
    ) => void;
  };
};

type ExecConfig = {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  exitCode?: number;
  closeDelayMs?: number;
  hangCreate?: boolean;
  onStart?: () => void;
  startDelayMs?: number;
  onStarted?: () => void;
  inspectError?: Error;
  inspectExitCodes?: Array<number | null>;
};

type ExecStream = PassThrough & { __execCfg?: ExecConfig };

type ContainerCreateOpts = {
  name?: string;
  Image?: string;
  Cmd?: string[];
  WorkingDir?: string;
  Labels?: Record<string, string>;
  HostConfig?: {
    Binds?: string[];
    PidsLimit?: number;
    Init?: boolean;
    Memory?: number;
    MemorySwap?: number;
    NanoCpus?: number;
    SecurityOpt?: string[];
    ExtraHosts?: string[];
    NetworkMode?: string;
  };
};

type PutArchiveCall = { buffer: Buffer; opts: { path: string } };

type NetworkConnectCall = { network: string; opts: { Container?: string } };

type MockState = {
  containerInspects: Array<() => Promise<{ State: { Running: boolean } }>>;
  imageInspects: Array<() => Promise<{ Id: string }>>;
  volumeInspects: Array<() => Promise<{ Name: string }>>;
  execQueue: ExecConfig[];
  createContainerCalls: ContainerCreateOpts[];
  createVolumeCalls: Record<string, unknown>[];
  putArchiveCalls: PutArchiveCall[];
  execCalls: Record<string, unknown>[];
  pullCalls: string[];
  pullError: Error | null;
  networkConnectCalls: NetworkConnectCall[];
  containerStop: () => Promise<void>;
  containerRemove: () => Promise<void>;
  volumeRemove: () => Promise<void>;
  lastContainer: FakeContainer | null;
  existingContainer: FakeContainer | null;
};

let mockState: MockState;

function makeFakeContainer(): FakeContainer {
  const demuxStream = (
    stream: PassThrough,
    stdoutPass: PassThrough,
    stderrPass: PassThrough,
  ) => {
    const cfg = (stream as ExecStream).__execCfg;
    process.nextTick(() => {
      if (cfg?.stdout) {
        stdoutPass.write(
          typeof cfg.stdout === "string"
            ? Buffer.from(cfg.stdout, "utf8")
            : cfg.stdout,
        );
      }
      if (cfg?.stderr) {
        stderrPass.write(
          typeof cfg.stderr === "string"
            ? Buffer.from(cfg.stderr, "utf8")
            : cfg.stderr,
        );
      }
    });
  };

  const container: FakeContainer = {
    inspect: vi.fn(() => {
      const next = mockState.containerInspects.shift();
      if (!next) {
        return Promise.resolve({ State: { Running: true } });
      }
      return next();
    }),
    start: vi.fn(() => Promise.resolve(undefined)),
    stop: vi.fn(() => mockState.containerStop()),
    remove: vi.fn(() => mockState.containerRemove()),
    exec: vi.fn((opts: Record<string, unknown>) => {
      mockState.execCalls.push(opts);
      const cfg: ExecConfig = mockState.execQueue.shift() ?? {};
      if (cfg.hangCreate) return new Promise(() => {});
      const stream: ExecStream = new PassThrough();
      stream.__execCfg = cfg;
      const closeStream = () => {
        stream.end();
        stream.emit("close");
      };
      const delay = cfg.closeDelayMs ?? 0;
      if (delay > 0) {
        setTimeout(closeStream, delay);
      } else {
        process.nextTick(closeStream);
      }
      return Promise.resolve({
        start: vi.fn(() => {
          cfg.onStart?.();
          const started = () => {
            cfg.onStarted?.();
            return stream;
          };
          const startDelay = cfg.startDelayMs ?? 0;
          if (startDelay <= 0) return Promise.resolve(started());
          return new Promise((resolve) =>
            setTimeout(() => resolve(started()), startDelay),
          );
        }),
        inspect: vi.fn(() => {
          if (cfg.inspectError) return Promise.reject(cfg.inspectError);
          const codes = cfg.inspectExitCodes;
          if (codes) {
            const code = codes.length > 1 ? codes.shift() : codes[0];
            return Promise.resolve({ ExitCode: code, Running: code === null });
          }
          return Promise.resolve({ ExitCode: cfg.exitCode ?? 0 });
        }),
      });
    }),
    putArchive: vi.fn((buffer: Buffer, opts: { path: string }) => {
      mockState.putArchiveCalls.push({ buffer, opts });
      return Promise.resolve(undefined);
    }),
    modem: { demuxStream },
  };
  return container;
}

vi.mock("dockerode", () => {
  class Docker {
    modem: {
      followProgress: (
        stream: PassThrough,
        cb: (err: Error | null) => void,
      ) => void;
      demuxStream: () => void;
    };

    constructor() {
      this.modem = {
        followProgress: (
          _stream: PassThrough,
          cb: (err: Error | null) => void,
        ) => {
          cb(mockState.pullError);
        },
        demuxStream: () => {},
      };
    }

    getContainer(_name: string) {
      if (mockState.existingContainer) return mockState.existingContainer;
      if (mockState.lastContainer) return mockState.lastContainer;
      const c = makeFakeContainer();
      mockState.lastContainer = c;
      return c;
    }

    getImage(_image: string) {
      return {
        inspect: vi.fn(() => {
          const next = mockState.imageInspects.shift();
          if (!next) return Promise.resolve({ Id: "sha256:abc" });
          return next();
        }),
      };
    }

    getVolume(_name: string) {
      return {
        inspect: vi.fn(() => {
          const next = mockState.volumeInspects.shift();
          if (!next) return Promise.resolve({ Name: _name });
          return next();
        }),
        remove: vi.fn(() => mockState.volumeRemove()),
      };
    }

    createContainer(opts: ContainerCreateOpts) {
      mockState.createContainerCalls.push(opts);
      const c = makeFakeContainer();
      mockState.lastContainer = c;
      return c;
    }

    createVolume(opts: Record<string, unknown>) {
      mockState.createVolumeCalls.push(opts);
      return {};
    }

    getNetwork(name: string) {
      return {
        connect: vi.fn((opts: { Container?: string }) => {
          mockState.networkConnectCalls.push({ network: name, opts });
          return Promise.resolve(undefined);
        }),
      };
    }

    pull(image: string) {
      mockState.pullCalls.push(image);
      return new PassThrough();
    }
  }
  return { default: Docker };
});

import {
  createDockerSandboxBackend,
  dockerSandboxConfigSchema,
} from "./backend.ts";
import { logger } from "../../logger.ts";
import { plugin } from "./index.ts";
import { loadPlugins } from "../loader.ts";
import {
  makeFakePluginLogger,
  makePluginContext,
  type FakePluginLogger,
} from "../../test-utils.ts";
import {
  MAX_READ_BYTES,
  MAX_SHELL_OUTPUT_BYTES,
  SANDBOX_WORKSPACE_ROOT,
  SHELL_OUTPUT_HEAD_BYTES,
  SHELL_OUTPUT_TAIL_BYTES,
} from "../../sandbox/index.ts";
import { buildFindArgs } from "../../sandbox/posix.ts";
import type {
  SandboxBackendRegistration,
  SandboxContext,
} from "../../sandbox/types.ts";

const ctx: SandboxContext = {
  orgId: "org-1",
  workspaceId: "ws-abc",
  userId: "user-1",
};
const callOptions = { signal: new AbortController().signal };

function resetMockState() {
  mockState = {
    containerInspects: [],
    imageInspects: [],
    volumeInspects: [],
    execQueue: [],
    createContainerCalls: [],
    createVolumeCalls: [],
    putArchiveCalls: [],
    execCalls: [],
    pullCalls: [],
    pullError: null,
    networkConnectCalls: [],
    containerStop: () => Promise.resolve(undefined),
    containerRemove: () => Promise.resolve(undefined),
    volumeRemove: () => Promise.resolve(undefined),
    lastContainer: null,
    existingContainer: null,
  };
}

function queueExec(cfg: ExecConfig = {}) {
  mockState.execQueue.push(cfg);
}

interface StatusError extends Error {
  statusCode: number;
}

function makeStatusError(message: string, statusCode: number): StatusError {
  const err = new Error(message) as StatusError;
  err.statusCode = statusCode;
  return err;
}

function setContainerMissing() {
  mockState.containerInspects.push(() =>
    Promise.reject(makeStatusError("no such container", 404)),
  );
}

function setImageMissing() {
  mockState.imageInspects.push(() =>
    Promise.reject(makeStatusError("no such image", 404)),
  );
}

function setVolumeMissing() {
  mockState.volumeInspects.push(() =>
    Promise.reject(makeStatusError("no such volume", 404)),
  );
}

function setupFreshProvision() {
  setContainerMissing();
  setImageMissing();
  setVolumeMissing();
  queueExec({ exitCode: 0 });
}

let pluginLogger: FakePluginLogger;

const withPluginLogger = () => ({
  config: { allowedNetworks: [] },
  credentials: {},
  logger: pluginLogger,
});

beforeEach(() => {
  resetMockState();
  vi.clearAllMocks();
  pluginLogger = makeFakePluginLogger();
});

describe("DockerSandboxTransport — provisioning", () => {
  it("provisions a new container when none exists", async () => {
    setupFreshProvision();
    queueExec({ stdout: "hi", exitCode: 0 });

    const backend = createDockerSandboxBackend({}, {}, withPluginLogger());
    await backend.shellExec(ctx, { command: "echo hi" }, callOptions);

    expect(mockState.pullCalls).toEqual(["debian:stable-slim"]);
    expect(mockState.createVolumeCalls).toHaveLength(1);
    expect(mockState.createContainerCalls).toHaveLength(1);
    expect(mockState.lastContainer?.start).toHaveBeenCalledTimes(1);

    expect(mockState.execCalls[0]).toMatchObject({
      Cmd: ["/bin/sh", "-c", `mkdir -p ${SANDBOX_WORKSPACE_ROOT}`],
    });
  });

  it("createContainer is called with the right config", async () => {
    setupFreshProvision();
    queueExec({ exitCode: 0 });

    const backend = createDockerSandboxBackend({}, {}, withPluginLogger());
    await backend.shellExec(ctx, { command: "true" }, callOptions);

    const opts = mockState.createContainerCalls[0];
    expect(opts.name).toBe("platypus-sandbox-ws-abc");
    expect(opts.Image).toBe("debian:stable-slim");
    expect(opts.Cmd).toEqual(["sleep", "infinity"]);
    expect(opts.WorkingDir).toBe("/workspace");
    expect(opts.Labels?.["platypus.sandbox"]).toBe("true");
    expect(opts.Labels?.["platypus.sandbox.workspaceId"]).toBe("ws-abc");
    expect(opts.HostConfig?.Binds).toEqual([
      "platypus-sandbox-vol-ws-abc:/workspace",
    ]);
    expect(opts.HostConfig?.PidsLimit).toBe(256);
    expect(opts.HostConfig?.Init).toBe(true);
    expect(opts.HostConfig?.Memory).toBe(2 * 1024 * 1024 * 1024);
    expect(opts.HostConfig?.MemorySwap).toBe(opts.HostConfig?.Memory);
    expect(opts.HostConfig?.NanoCpus).toBe(2_000_000_000);
    expect(opts.HostConfig?.SecurityOpt).toEqual(["no-new-privileges:true"]);
    expect(opts.HostConfig?.ExtraHosts).toEqual([]);
    expect(opts.HostConfig?.NetworkMode).toBeUndefined();
  });

  it("reuses an existing running container without re-creating", async () => {
    mockState.existingContainer = makeFakeContainer();
    mockState.containerInspects.push(() =>
      Promise.resolve({ State: { Running: true } }),
    );
    queueExec({ stdout: "ok", exitCode: 0 });

    const backend = createDockerSandboxBackend({}, {}, withPluginLogger());
    await backend.shellExec(ctx, { command: "true" }, callOptions);

    expect(mockState.createContainerCalls).toHaveLength(0);
    expect(mockState.createVolumeCalls).toHaveLength(0);
    expect(mockState.pullCalls).toHaveLength(0);
    expect(mockState.imageInspects).toHaveLength(0);
  });

  it("starts an existing stopped container", async () => {
    mockState.existingContainer = makeFakeContainer();
    mockState.containerInspects.push(() =>
      Promise.resolve({ State: { Running: false } }),
    );
    queueExec({ exitCode: 0 });

    const backend = createDockerSandboxBackend({}, {}, withPluginLogger());
    await backend.shellExec(ctx, { command: "true" }, callOptions);

    expect(mockState.existingContainer.start).toHaveBeenCalledTimes(1);
    expect(mockState.createContainerCalls).toHaveLength(0);
  });

  it("surfaces a daemon failure that is not a missing container", async () => {
    mockState.containerInspects.push(() =>
      Promise.reject(makeStatusError("daemon unavailable", 500)),
    );

    const backend = createDockerSandboxBackend({}, {}, withPluginLogger());

    await expect(
      backend.shellExec(ctx, { command: "true" }, callOptions),
    ).rejects.toThrow("daemon unavailable");
    expect(mockState.createContainerCalls).toHaveLength(0);
  });

  it("fails provisioning when the image pull fails", async () => {
    setContainerMissing();
    setImageMissing();
    mockState.pullError = new Error("pull access denied");

    const backend = createDockerSandboxBackend({}, {}, withPluginLogger());

    await expect(
      backend.shellExec(ctx, { command: "true" }, callOptions),
    ).rejects.toThrow("pull access denied");
    expect(mockState.createContainerCalls).toHaveLength(0);
  });

  it("in-flight memoisation: concurrent calls share one provisioning", async () => {
    setupFreshProvision();
    queueExec({ exitCode: 0 });
    queueExec({ exitCode: 0 });

    const backend = createDockerSandboxBackend({}, {}, withPluginLogger());
    await Promise.all([
      backend.shellExec(ctx, { command: "a" }, callOptions),
      backend.shellExec(ctx, { command: "b" }, callOptions),
    ]);

    expect(mockState.createContainerCalls).toHaveLength(1);
  });
});

describe("DockerSandboxTransport — argv safety", () => {
  it("fsRead passes shell-metachar path as literal argv", async () => {
    setupFreshProvision();
    queueExec({ stdout: "data", exitCode: 0 });

    const backend = createDockerSandboxBackend({}, {}, withPluginLogger());
    const malicious = `foo";rm -rf /`;
    await backend.fsRead(ctx, { path: malicious }, callOptions);

    const last = mockState.execCalls.at(-1) as { Cmd: string[] };
    expect(last.Cmd).toEqual([
      "head",
      "-c",
      String(MAX_READ_BYTES),
      "--",
      `/workspace/${malicious}`,
    ]);
  });

  it("fsRead bounds the read output at the cap core asked for", async () => {
    setupFreshProvision();
    queueExec({ stdout: "a".repeat(MAX_READ_BYTES + 5_000), exitCode: 0 });

    const backend = createDockerSandboxBackend({}, {}, withPluginLogger());
    const res = await backend.fsRead(ctx, { path: "big.txt" }, callOptions);

    expect(res.content).toHaveLength(MAX_READ_BYTES);
  });

  it("fsList hands core's find argv to dockerode unmodified", async () => {
    mockState.existingContainer = makeFakeContainer();
    mockState.containerInspects.push(() =>
      Promise.resolve({ State: { Running: true } }),
    );
    queueExec({ stdout: "", exitCode: 0 });

    const backend = createDockerSandboxBackend({}, {}, withPluginLogger());
    await backend.fsList(ctx, { glob: "**/*.ts" }, callOptions);

    const call = mockState.execCalls[0] as { Cmd: string[] };
    expect(call.Cmd).toEqual(
      buildFindArgs(SANDBOX_WORKSPACE_ROOT, { glob: "**/*.ts" }),
    );
  });

  it.each([
    [
      "the command's stderr",
      "head: cannot open 'nope' for reading: No such file or directory\n",
      /No such file/,
    ],
    ["a generic reason when stderr is empty", "", /read failed/],
  ])(
    "fsRead reports %s when the read fails",
    async (_label, stderr, expected) => {
      setupFreshProvision();
      queueExec({ stderr, exitCode: 1 });

      const backend = createDockerSandboxBackend({}, {}, withPluginLogger());

      await expect(
        backend.fsRead(ctx, { path: "nope" }, callOptions),
      ).rejects.toThrow(expected);
    },
  );

  it("fsWrite creates a nested parent first and extracts into it", async () => {
    mockState.existingContainer = makeFakeContainer();
    queueExec({ exitCode: 0 });

    const backend = createDockerSandboxBackend({}, {}, withPluginLogger());
    await backend.fsWrite(
      ctx,
      {
        path: "a/b/c.txt",
        content: "x",
        mode: "overwrite",
      },
      callOptions,
    );

    expect(mockState.execCalls).toEqual([
      expect.objectContaining({ Cmd: ["mkdir", "-p", "/workspace/a/b"] }),
    ]);
    expect(mockState.putArchiveCalls[0].opts).toEqual({
      path: "/workspace/a/b",
    });
  });

  it("fsWrite refuses to extract when the parent cannot be created", async () => {
    mockState.existingContainer = makeFakeContainer();
    queueExec({ exitCode: 1 });

    const backend = createDockerSandboxBackend({}, {}, withPluginLogger());

    await expect(
      backend.fsWrite(
        ctx,
        {
          path: "a/b/c.txt",
          content: "x",
          mode: "overwrite",
        },
        callOptions,
      ),
    ).rejects.toThrow("failed to create parent directory: /workspace/a/b");
    expect(mockState.putArchiveCalls).toHaveLength(0);
  });

  it("fsWrite create-mode probes with [test, -e, <path>] and throws if exists", async () => {
    setupFreshProvision();
    queueExec({ exitCode: 0 });

    const backend = createDockerSandboxBackend({}, {}, withPluginLogger());
    await expect(
      backend.fsWrite(
        ctx,
        {
          path: "foo",
          content: "bar",
          mode: "create",
        },
        callOptions,
      ),
    ).rejects.toThrow(/already exists/);

    const probeCall = mockState.execCalls.at(-1) as { Cmd: string[] };
    expect(probeCall.Cmd).toEqual(["test", "-e", "/workspace/foo"]);
  });

  it("fsWrite overwrite mode skips the probe and calls putArchive", async () => {
    mockState.existingContainer = makeFakeContainer();
    mockState.containerInspects.push(() =>
      Promise.resolve({ State: { Running: true } }),
    );

    const backend = createDockerSandboxBackend({}, {}, withPluginLogger());
    await backend.fsWrite(
      ctx,
      {
        path: "foo.txt",
        content: "hello",
        mode: "overwrite",
      },
      callOptions,
    );
    expect(mockState.execCalls.length).toBe(0);
    expect(mockState.putArchiveCalls).toHaveLength(1);
    expect(mockState.putArchiveCalls[0].opts).toEqual({ path: "/workspace" });
  });
});

function tarEntryName(tar: Buffer): string {
  const nameBytes = tar.subarray(0, 100);
  const nul = nameBytes.indexOf(0);
  return nameBytes.subarray(0, nul === -1 ? 100 : nul).toString("utf8");
}

function tarEntrySize(tar: Buffer): number {
  return Number.parseInt(tar.subarray(124, 136).toString("utf8"), 8);
}

describe("DockerSandboxTransport — byte transfer", () => {
  it("round-trips a binary payload byte-identical through putArchive and a read", async () => {
    mockState.existingContainer = makeFakeContainer();
    queueExec({ exitCode: 0 });
    const payload = Buffer.concat([
      Buffer.from([0x00, 0xff, 0xfe, 0xc3, 0x28]),
      randomBytes(4096),
    ]);

    const backend = createDockerSandboxBackend({}, {}, withPluginLogger());
    await backend.fsWriteBytes!(
      ctx,
      { path: "bin/blob", bytes: new Uint8Array(payload) },
      callOptions,
    );

    const tar = mockState.putArchiveCalls[0].buffer;
    const size = tarEntrySize(tar);
    queueExec({ stdout: tar.subarray(512, 512 + size), exitCode: 0 });

    const read = await backend.fsReadBytes!(
      ctx,
      { path: "bin/blob", maxBytes: SANDBOX_TRANSFER_MAX_BYTES },
      callOptions,
    );

    expect(mockState.execCalls[0]).toMatchObject({
      Cmd: ["mkdir", "-p", "/workspace/bin"],
    });
    expect(mockState.putArchiveCalls[0].opts).toEqual({
      path: "/workspace/bin",
    });
    expect(Buffer.from(read).equals(payload)).toBe(true);
  });
});

describe("DockerSandboxTransport — archive handed to putArchive", () => {
  function makeBackend() {
    mockState.existingContainer = makeFakeContainer();
    queueExec({ exitCode: 0 });
    return createDockerSandboxBackend({}, {}, withPluginLogger());
  }

  async function writeAndCaptureTar(
    backend: ReturnType<typeof makeBackend>,
    path: string,
    content: string,
  ): Promise<Buffer> {
    await backend.fsWrite(
      ctx,
      { path, content, mode: "overwrite" },
      callOptions,
    );
    const archive = mockState.putArchiveCalls.at(-1);
    if (!archive) throw new Error("fsWrite handed no archive to putArchive");
    return archive.buffer;
  }

  it("writes the file's bytes as a parseable ustar entry", async () => {
    const content = "hello world";
    const tar = await writeAndCaptureTar(makeBackend(), "a/b.txt", content);

    expect(tar.length % 512).toBe(0);
    expect(tar.subarray(257, 262).toString("utf8")).toBe("ustar");

    const sizeField = tar.subarray(124, 136).toString("utf8");
    const expectedSize =
      Buffer.byteLength(content).toString(8).padStart(11, "0") + " ";
    expect(sizeField).toBe(expectedSize);
    expect(tarEntrySize(tar)).toBe(Buffer.byteLength(content));
  });

  it("names the entry after the file alone, never the parent path", async () => {
    const backend = makeBackend();

    expect(
      tarEntryName(await writeAndCaptureTar(backend, "a/b.txt", "x")),
    ).toBe("b.txt");
  });

  it("refuses an entry name over the 100-byte ustar field", async () => {
    const backend = makeBackend();

    await backend.fsWrite(
      ctx,
      { path: "a".repeat(100), content: "x", mode: "overwrite" },
      callOptions,
    );
    expect(mockState.putArchiveCalls).toHaveLength(1);

    await expect(
      backend.fsWrite(
        ctx,
        { path: "a".repeat(101), content: "x", mode: "overwrite" },
        callOptions,
      ),
    ).rejects.toThrow(/too long/);
    expect(mockState.putArchiveCalls).toHaveLength(1);
  });
});

describe("DockerSandboxTransport — destroy() idempotence", () => {
  it("swallows 404 on stop and proceeds to remove + volume remove", async () => {
    mockState.existingContainer = makeFakeContainer();
    mockState.containerStop = () =>
      Promise.reject(makeStatusError("no such container", 404));

    const backend = createDockerSandboxBackend({}, {}, withPluginLogger());
    await expect(backend.destroy(ctx)).resolves.toBeUndefined();
    expect(pluginLogger.warn).not.toHaveBeenCalled();
  });

  it("swallows 304 (already stopped) on stop", async () => {
    mockState.existingContainer = makeFakeContainer();
    mockState.containerStop = () =>
      Promise.reject(makeStatusError("already stopped", 304));

    const backend = createDockerSandboxBackend({}, {}, withPluginLogger());
    await expect(backend.destroy(ctx)).resolves.toBeUndefined();
    expect(pluginLogger.warn).not.toHaveBeenCalled();
  });

  it("swallows 404 on container remove and on volume remove", async () => {
    mockState.existingContainer = makeFakeContainer();
    mockState.containerRemove = () =>
      Promise.reject(makeStatusError("not found", 404));
    mockState.volumeRemove = () =>
      Promise.reject(makeStatusError("not found", 404));

    const backend = createDockerSandboxBackend({}, {}, withPluginLogger());
    await expect(backend.destroy(ctx)).resolves.toBeUndefined();
    expect(pluginLogger.warn).not.toHaveBeenCalled();
  });

  it("logs to the injected logger but proceeds when stop returns 500", async () => {
    mockState.existingContainer = makeFakeContainer();
    mockState.containerStop = () =>
      Promise.reject(makeStatusError("internal", 500));
    let removeCalled = false;
    mockState.containerRemove = () => {
      removeCalled = true;
      return Promise.resolve(undefined);
    };
    let volRemoveCalled = false;
    mockState.volumeRemove = () => {
      volRemoveCalled = true;
      return Promise.resolve(undefined);
    };

    const backend = createDockerSandboxBackend({}, {}, withPluginLogger());
    await backend.destroy(ctx);

    expect(pluginLogger.warn).toHaveBeenCalledTimes(1);
    expect(pluginLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-abc" }),
      "sandbox destroy: stop failed (continuing)",
    );
    expect(logger.warn).not.toHaveBeenCalled();
    expect(removeCalled).toBe(true);
    expect(volRemoveCalled).toBe(true);
  });
});

function execMarker(call: Record<string, unknown>): string {
  const env = (call.Env as string[] | undefined) ?? [];
  const entry = env.find((e) => e.startsWith("PLATYPUS_EXEC_ID="));
  if (!entry) throw new Error("exec carries no marker");
  return entry.slice("PLATYPUS_EXEC_ID=".length);
}

function killCallsFor(marker: string): Record<string, unknown>[] {
  return mockState.execCalls.filter((c) =>
    (c.Cmd as string[]).includes(marker),
  );
}

describe("DockerSandboxTransport — shellExec output handling", () => {
  it("times out: returns exitCode 124 and destroys the stream", async () => {
    setupFreshProvision();
    queueExec({ closeDelayMs: 200, exitCode: 0 });

    const backend = createDockerSandboxBackend({}, {}, withPluginLogger());
    const res = await backend.shellExec(
      ctx,
      {
        command: "sleep 5",
        timeoutMs: 20,
      },
      callOptions,
    );

    expect(res.exitCode).toBe(124);
  });

  it("closes the exec stream and rejects when the turn is cancelled", async () => {
    setupFreshProvision();
    queueExec({ closeDelayMs: 5_000, exitCode: 0 });

    const backend = createDockerSandboxBackend({}, {}, withPluginLogger());
    const controller = new AbortController();
    const inflight = backend.shellExec(
      ctx,
      { command: "sleep 300" },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(mockState.execCalls).toHaveLength(2));
    controller.abort();

    await expect(inflight).rejects.toThrow(/cancelled/i);
  });

  it("stops waiting when the daemon hangs before the command is started", async () => {
    setupFreshProvision();
    queueExec({ hangCreate: true });

    const backend = createDockerSandboxBackend({}, {}, withPluginLogger());
    const controller = new AbortController();
    const inflight = backend.shellExec(
      ctx,
      { command: "ls" },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(mockState.execCalls).toHaveLength(2));
    controller.abort();

    await expect(inflight).rejects.toThrow(/cancelled/i);
  });

  it("catches an abort that lands while the exec is being started", async () => {
    setupFreshProvision();
    const controller = new AbortController();
    queueExec({
      closeDelayMs: 5_000,
      exitCode: 0,
      onStart: () => controller.abort(),
    });

    const backend = createDockerSandboxBackend({}, {}, withPluginLogger());

    await expect(
      backend.shellExec(
        ctx,
        { command: "sleep 300" },
        { signal: controller.signal },
      ),
    ).rejects.toThrow(/cancelled/i);
  });

  it("keeps the head and tail of stdout over MAX_SHELL_OUTPUT_BYTES and flags truncated", async () => {
    setupFreshProvision();
    const huge = "a".repeat(MAX_SHELL_OUTPUT_BYTES + 5_000);
    queueExec({ stdout: huge, exitCode: 0 });

    const backend = createDockerSandboxBackend({}, {}, withPluginLogger());
    const res = await backend.shellExec(ctx, { command: "yes" }, callOptions);

    expect(res.stdout.startsWith("a".repeat(SHELL_OUTPUT_HEAD_BYTES))).toBe(
      true,
    );
    expect(res.stdout.endsWith("a".repeat(SHELL_OUTPUT_TAIL_BYTES))).toBe(true);
    expect(res.stdout).toContain("bytes omitted");
    expect(res.truncated).toBe(true);
  });
});

describe("DockerSandboxTransport — ending a command that did not finish", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("kills everything the command started when it times out", async () => {
    setupFreshProvision();
    queueExec({ closeDelayMs: 5_000, exitCode: 0 });

    const backend = createDockerSandboxBackend({}, {}, withPluginLogger());
    const res = await backend.shellExec(
      ctx,
      { command: "sleep infinity", timeoutMs: 20 },
      callOptions,
    );

    expect(res.exitCode).toBe(124);
    const command = mockState.execCalls[1];
    expect(killCallsFor(execMarker(command))).toHaveLength(1);
  });

  it("kills everything the command started when the turn is cancelled", async () => {
    setupFreshProvision();
    queueExec({ closeDelayMs: 5_000, exitCode: 0 });

    const backend = createDockerSandboxBackend({}, {}, withPluginLogger());
    const controller = new AbortController();
    const inflight = backend.shellExec(
      ctx,
      { command: "sleep infinity" },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(mockState.execCalls).toHaveLength(2));
    controller.abort();

    await expect(inflight).rejects.toThrow(/cancelled/i);
    const command = mockState.execCalls[1];
    await vi.waitFor(() =>
      expect(killCallsFor(execMarker(command))).toHaveLength(1),
    );
  });

  it("kills a command whose start lands after the turn is cancelled", async () => {
    setupFreshProvision();
    let commandStarted = false;
    let startedBeforeKill = false;
    queueExec({
      closeDelayMs: 5_000,
      startDelayMs: 50,
      onStarted: () => (commandStarted = true),
    });
    queueExec({ onStart: () => (startedBeforeKill = commandStarted) });

    const backend = createDockerSandboxBackend({}, {}, withPluginLogger());
    const controller = new AbortController();
    const inflight = backend.shellExec(
      ctx,
      { command: "sleep infinity" },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(mockState.execCalls).toHaveLength(2));
    controller.abort();

    await expect(inflight).rejects.toThrow(/cancelled/i);
    const command = mockState.execCalls[1];
    expect(killCallsFor(execMarker(command))).toHaveLength(1);
    expect(startedBeforeKill).toBe(true);
  });

  it("leaves a command that finished alone", async () => {
    setupFreshProvision();
    queueExec({ stdout: "hi", exitCode: 0 });

    const backend = createDockerSandboxBackend({}, {}, withPluginLogger());
    await backend.shellExec(ctx, { command: "echo hi" }, callOptions);

    expect(mockState.execCalls).toHaveLength(2);
  });

  it("gives every exec its own marker, alongside the command's env", async () => {
    setupFreshProvision();
    queueExec({ exitCode: 0 });
    queueExec({ exitCode: 0 });

    const backend = createDockerSandboxBackend({}, {}, withPluginLogger());
    await backend.shellExec(
      ctx,
      { command: "true", env: { FOO: "bar" } },
      callOptions,
    );
    await backend.shellExec(ctx, { command: "true" }, callOptions);

    const [, first, second] = mockState.execCalls;
    expect(first.Env).toContain("FOO=bar");
    expect(execMarker(first)).not.toBe(execMarker(second));
  });

  it("keeps its own marker when the command's env names the marker variable", async () => {
    setupFreshProvision();
    queueExec({ exitCode: 0 });

    const backend = createDockerSandboxBackend({}, {}, withPluginLogger());
    await backend.shellExec(
      ctx,
      { command: "true", env: { PLATYPUS_EXEC_ID: "spoofed" } },
      callOptions,
    );

    const env = mockState.execCalls[1].Env as string[];
    expect(env.at(-1)).toMatch(/^PLATYPUS_EXEC_ID=/);
    expect(env.at(-1)).not.toBe("PLATYPUS_EXEC_ID=spoofed");
  });

  it("still reports the timeout when the kill cannot be delivered", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    setupFreshProvision();
    queueExec({ closeDelayMs: 600_000, exitCode: 0 });
    queueExec({ hangCreate: true });

    const backend = createDockerSandboxBackend({}, {}, withPluginLogger());
    const inflight = backend.shellExec(
      ctx,
      { command: "sleep infinity", timeoutMs: 20 },
      callOptions,
    );
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(inflight).resolves.toMatchObject({ exitCode: 124 });
    expect(pluginLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: ctx.workspaceId }),
      expect.stringMatching(/could not kill/),
    );
  });

  it("gives up on a read that never finishes, and kills it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    setupFreshProvision();
    queueExec({ closeDelayMs: 3_600_000, exitCode: 0 });

    const backend = createDockerSandboxBackend({}, {}, withPluginLogger());
    const inflight = backend.fsRead(ctx, { path: "fifo" }, callOptions);
    const settled = expect(inflight).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(120_000);
    await settled;

    const read = mockState.execCalls[1];
    expect(killCallsFor(execMarker(read))).toHaveLength(1);
  });

  it("kills a read when the turn is cancelled, without waiting for its timeout", async () => {
    setupFreshProvision();
    queueExec({ closeDelayMs: 3_600_000, exitCode: 0 });

    const backend = createDockerSandboxBackend({}, {}, withPluginLogger());
    const controller = new AbortController();
    const inflight = backend.fsRead(
      ctx,
      { path: "fifo" },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(mockState.execCalls).toHaveLength(2));
    controller.abort();

    await expect(inflight).rejects.toThrow(/cancelled/i);
    const read = mockState.execCalls[1];
    await vi.waitFor(() =>
      expect(killCallsFor(execMarker(read))).toHaveLength(1),
    );
  });
});

describe("DockerSandboxTransport — exit status", () => {
  it("reports a failed exec inspect as an error, not a success", async () => {
    setupFreshProvision();
    queueExec({ stdout: "hi", inspectError: new Error("daemon gone") });

    const backend = createDockerSandboxBackend({}, {}, withPluginLogger());

    await expect(
      backend.shellExec(ctx, { command: "false" }, callOptions),
    ).rejects.toThrow(/daemon gone/);
  });

  it("waits for the daemon to record the exit code", async () => {
    setupFreshProvision();
    queueExec({ inspectExitCodes: [null, null, 3] });

    const backend = createDockerSandboxBackend({}, {}, withPluginLogger());
    const res = await backend.shellExec(
      ctx,
      { command: "exit 3" },
      callOptions,
    );

    expect(res.exitCode).toBe(3);
  });

  it("reports an exit code the daemon never records as an error, and kills the command", async () => {
    setupFreshProvision();
    queueExec({ inspectExitCodes: [null] });

    const backend = createDockerSandboxBackend({}, {}, withPluginLogger());

    await expect(
      backend.shellExec(ctx, { command: "true" }, callOptions),
    ).rejects.toThrow(/exit code/i);
    const command = mockState.execCalls[1];
    expect(killCallsFor(execMarker(command))).toHaveLength(1);
  });
});

describe("DockerSandboxTransport — host reachability (ADR-0005)", () => {
  it("applies configured extraHosts to HostConfig.ExtraHosts", async () => {
    setupFreshProvision();
    queueExec({ exitCode: 0 });

    const backend = createDockerSandboxBackend(
      { extraHosts: ["host.docker.internal:host-gateway"] },
      {},
      withPluginLogger(),
    );
    await backend.shellExec(ctx, { command: "true" }, callOptions);

    expect(mockState.createContainerCalls[0].HostConfig?.ExtraHosts).toEqual([
      "host.docker.internal:host-gateway",
    ]);
  });

  it("sets the first network as NetworkMode and connects the rest", async () => {
    setupFreshProvision();
    queueExec({ exitCode: 0 });

    const backend = createDockerSandboxBackend(
      { networks: ["primary", "secondary", "tertiary"] },
      {},
      withPluginLogger(),
    );
    await backend.shellExec(ctx, { command: "true" }, callOptions);

    expect(mockState.createContainerCalls[0].HostConfig?.NetworkMode).toBe(
      "primary",
    );
    expect(mockState.networkConnectCalls.map((c) => c.network)).toEqual([
      "secondary",
      "tertiary",
    ]);
    expect(
      mockState.networkConnectCalls.every((c) => "Container" in c.opts),
    ).toBe(true);
  });

  it("a single network sets NetworkMode and makes no connect calls", async () => {
    setupFreshProvision();
    queueExec({ exitCode: 0 });

    const backend = createDockerSandboxBackend(
      { networks: ["only"] },
      {},
      withPluginLogger(),
    );
    await backend.shellExec(ctx, { command: "true" }, callOptions);

    expect(mockState.createContainerCalls[0].HostConfig?.NetworkMode).toBe(
      "only",
    );
    expect(mockState.networkConnectCalls).toHaveLength(0);
  });

  describe("dockerSandboxConfigSchema (factory of plugin config)", () => {
    it("defaults to empty arrays for {}", () => {
      const parsed = dockerSandboxConfigSchema(
        makePluginContext({ config: { allowedNetworks: [] } }),
      ).parse({});
      expect(parsed).toEqual({ networks: [], extraHosts: [] });
    });

    it("accepts networks that are in the operator allowlist", () => {
      const parsed = dockerSandboxConfigSchema(
        makePluginContext({
          config: {
            allowedNetworks: ["shared", "tools"],
          },
        }),
      ).parse({ networks: ["shared"] });
      expect(parsed.networks).toEqual(["shared"]);
    });

    it("rejects networks outside the operator allowlist", () => {
      const result = dockerSandboxConfigSchema(
        makePluginContext({
          config: {
            allowedNetworks: ["shared"],
          },
        }),
      ).safeParse({ networks: ["not-allowed"] });
      expect(result.success).toBe(false);
    });

    it("rejects any network under an empty allowlist (default-deny)", () => {
      const result = dockerSandboxConfigSchema(
        makePluginContext({
          config: {
            allowedNetworks: [],
          },
        }),
      ).safeParse({ networks: ["shared"] });
      expect(result.success).toBe(false);
    });

    it("names the plugin-config allowlist source in the error", () => {
      const result = dockerSandboxConfigSchema(
        makePluginContext({
          config: {
            allowedNetworks: [],
          },
        }),
      ).safeParse({ networks: ["nope"] });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain(
          "@platypus/docker plugin config 'allowedNetworks'",
        );
      }
    });

    it("rejects malformed extraHosts entries", () => {
      const result = dockerSandboxConfigSchema(
        makePluginContext({
          config: {
            allowedNetworks: [],
          },
        }),
      ).safeParse({ extraHosts: ["not a valid entry"] });
      expect(result.success).toBe(false);
    });
  });
});

describe("DockerSandboxTransport — plugin-injected logger", () => {
  it("writes the image-pull line to the injected logger, not core's", async () => {
    setupFreshProvision();
    queueExec({ stdout: "hi", exitCode: 0 });
    const backend = createDockerSandboxBackend({}, {}, withPluginLogger());
    await backend.shellExec(ctx, { command: "echo hi" }, callOptions);

    expect(mockState.pullCalls).toEqual(["debian:stable-slim"]);
    expect(pluginLogger.info).toHaveBeenCalledWith(
      { image: "debian:stable-slim" },
      "Pulling sandbox image",
    );
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("names each teardown step it could not complete", async () => {
    mockState.existingContainer = makeFakeContainer();
    mockState.containerStop = () =>
      Promise.reject(makeStatusError("internal", 500));
    mockState.containerRemove = () =>
      Promise.reject(makeStatusError("internal", 500));
    mockState.volumeRemove = () =>
      Promise.reject(makeStatusError("internal", 500));
    const backend = createDockerSandboxBackend({}, {}, withPluginLogger());
    await backend.destroy(ctx);

    expect(pluginLogger.warn.mock.calls.map((c) => c[1])).toEqual([
      "sandbox destroy: stop failed (continuing)",
      "sandbox destroy: container remove failed (continuing)",
      "sandbox destroy: volume remove failed",
    ]);
  });

  it("reaches the adapter through the manifest's create()", async () => {
    setupFreshProvision();
    queueExec({ stdout: "hi", exitCode: 0 });
    const contribution = plugin.contributes.sandboxBackends![0];
    const backend = contribution.create({}, {}, withPluginLogger());
    await backend.shellExec(ctx, { command: "echo hi" }, callOptions);

    expect(pluginLogger.info).toHaveBeenCalledWith(
      { image: "debian:stable-slim" },
      "Pulling sandbox image",
    );
  });

  it("carries the manifest name on its lines when loaded by the real loader", async () => {
    setupFreshProvision();
    queueExec({ stdout: "hi", exitCode: 0 });

    const lines: Array<{ bindings: object; fields: object; msg?: string }> = [];
    const baseLogger = {
      child: (bindings: Record<string, unknown>) => {
        const write =
          (level: string) => (objOrMsg: object | string, msg?: string) =>
            lines.push({
              bindings: { ...bindings, level },
              fields: typeof objOrMsg === "string" ? {} : objOrMsg,
              msg: typeof objOrMsg === "string" ? objOrMsg : msg,
            });
        return {
          debug: write("debug"),
          info: write("info"),
          warn: write("warn"),
          error: write("error"),
        };
      },
    };

    const captured: SandboxBackendRegistration<unknown, unknown>[] = [];
    await loadPlugins({
      pluginNames: ["@platypus/docker"],
      registerSandbox: (c) => captured.push(c),
      baseLogger,
    });

    const backend = captured[0].create({}, {});
    await backend.shellExec(ctx, { command: "echo hi" }, callOptions);

    expect(lines).toContainEqual({
      bindings: { plugin: "@platypus/docker", level: "info" },
      fields: { image: "debian:stable-slim" },
      msg: "Pulling sandbox image",
    });
  });
});
