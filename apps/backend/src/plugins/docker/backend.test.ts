import { describe, it, expect, beforeEach, vi } from "vitest";
import { PassThrough } from "node:stream";

// ---------------------------------------------------------------------------
// This suite covers the Docker *transport* only: container/volume lifecycle,
// the tar builder, idempotent teardown, and that dockerode is driven with the
// argv it was handed. The five-tool contract those primitives sit under —
// line counting, truncation flags, the timeout clamp, the unique-`oldString`
// rule, the find(1) argv and its output parser — belongs to
// `createPosixSandbox` and is tested once in `src/sandbox/posix.test.ts`.
// Duplicating any of it here would just give the same rule two homes.
//
// The tests still drive the composed backend (`createDockerSandboxBackend`)
// rather than the transport in isolation, because what reaches dockerode is
// only interesting once core has resolved the path and built the argv.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Mock dockerode. The default export is a class; calling `new Docker()` must
// return our fake docker handle. We pull state out of `mockState` so tests can
// configure per-call behaviour.
// ---------------------------------------------------------------------------

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
  /** Delay (ms) before stream closes — used to test timeout behaviour. */
  closeDelayMs?: number;
};

/** A PassThrough stream extended with optional exec configuration attached by the mock. */
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
  // Sequence of behaviours for container.inspect() — popped left-to-right.
  containerInspects: Array<() => Promise<{ State: { Running: boolean } }>>;
  // Sequence for image.inspect().
  imageInspects: Array<() => Promise<{ Id: string }>>;
  // Sequence for volume.inspect().
  volumeInspects: Array<() => Promise<{ Name: string }>>;
  // Sequence of exec behaviours, popped on each exec.
  execQueue: ExecConfig[];
  // Recorded calls.
  createContainerCalls: ContainerCreateOpts[];
  createVolumeCalls: Record<string, unknown>[];
  putArchiveCalls: PutArchiveCall[];
  execCalls: Record<string, unknown>[];
  pullCalls: string[];
  // Recorded network.connect() calls (additional networks beyond the primary).
  networkConnectCalls: NetworkConnectCall[];
  // Per-container stop/remove handlers (keyed by container name).
  containerStop: () => Promise<void>;
  containerRemove: () => Promise<void>;
  volumeRemove: () => Promise<void>;
  // Track last container so tests can assert .start() was called.
  lastContainer: FakeContainer | null;
  // Track the *existing* container (returned by getContainer before create).
  existingContainer: FakeContainer | null;
};

let mockState: MockState;

function makeFakeContainer(): FakeContainer {
  const demuxStream = (
    stream: PassThrough,
    stdoutPass: PassThrough,
    stderrPass: PassThrough,
  ) => {
    // Read the most recently configured exec output (set on exec.start()).
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
        // Default: container running.
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
      const stream: ExecStream = new PassThrough();
      stream.__execCfg = cfg;
      // Production code awaits stream.on("end" | "close" | "error"). Since
      // nothing actually consumes `stream` itself (demuxStream is mocked to
      // write to the pass-throughs directly), we manually emit "close" to
      // unblock the await.
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
        start: vi.fn(() => Promise.resolve(stream)),
        inspect: vi.fn(() => Promise.resolve({ ExitCode: cfg.exitCode ?? 0 })),
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
          cb(null);
        },
        demuxStream: () => {
          // unused at the top level — production code reaches via container.modem
        },
      };
    }

    getContainer(_name: string) {
      // Return the existing-container fake if present, else lastContainer (post-create).
      if (mockState.existingContainer) return mockState.existingContainer;
      if (mockState.lastContainer) return mockState.lastContainer;
      // Fallback for destroy() paths where nothing was ever provisioned in this test.
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
      // After creation, getContainer() should return this same container.
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
      // The production code only uses the returned stream as a token; the
      // modem.followProgress mock calls back immediately so the stream is
      // never actually read.
      return new PassThrough();
    }
  }
  return { default: Docker };
});

// Mock logger so we can assert warning behaviour in destroy().
vi.mock("../../logger.ts", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Import AFTER vi.mock so the adapter binds to our mocked dockerode.
import {
  createDockerSandboxBackend,
  buildSingleFileTar,
  dockerSandboxConfigSchema,
} from "./backend.ts";
import { logger } from "../../logger.ts";
import { plugin } from "./index.ts";
import { loadPlugins } from "../loader.ts";
import type { SandboxBackendContribution } from "@platypuschat/plugin-sdk";
import {
  makeFakePluginLogger,
  type FakePluginLogger,
} from "../../test-utils.ts";
import {
  MAX_READ_BYTES,
  MAX_SHELL_OUTPUT_BYTES,
  SANDBOX_WORKSPACE_ROOT,
} from "../../sandbox/index.ts";
import { buildFindArgs } from "../../sandbox/posix.ts";
import type { SandboxContext } from "../../sandbox/types.ts";

const ctx: SandboxContext = {
  orgId: "org-1",
  workspaceId: "ws-abc",
  userId: "user-1",
};

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
    networkConnectCalls: [],
    containerStop: () => Promise.resolve(undefined),
    containerRemove: () => Promise.resolve(undefined),
    volumeRemove: () => Promise.resolve(undefined),
    lastContainer: null,
    existingContainer: null,
  };
}

// Helpers for setting up exec output sequences.
function queueExec(cfg: ExecConfig = {}) {
  mockState.execQueue.push(cfg);
}

/** A Docker-style error with an HTTP status code. */
interface StatusError extends Error {
  statusCode: number;
}

function makeStatusError(message: string, statusCode: number): StatusError {
  const err = new Error(message) as StatusError;
  err.statusCode = statusCode;
  return err;
}

/** Configure container.inspect() to reject 404 (no such container). */
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

/** Configure a fresh provisioning path: every check returns 404 until create. */
function setupFreshProvision() {
  setContainerMissing();
  setImageMissing();
  setVolumeMissing();
  // After provisioning, the mkdir -p workspace exec is invoked.
  queueExec({ exitCode: 0 });
}

// The `PluginLogger` seam core injects on the plugin's deploy-time block. The
// adapter logs through this rather than core's logger, so any suite asserting on
// a log line injects one and watches it — watching core's would pass vacuously.
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
    // Plus an exec for the actual tool call.
    queueExec({ stdout: "hi", exitCode: 0 });

    const backend = createDockerSandboxBackend({}, {});
    await backend.shellExec(ctx, { command: "echo hi" });

    expect(mockState.pullCalls).toEqual(["debian:stable-slim"]);
    expect(mockState.createVolumeCalls).toHaveLength(1);
    expect(mockState.createContainerCalls).toHaveLength(1);
    expect(mockState.lastContainer?.start).toHaveBeenCalledTimes(1);

    // First exec on the new container is the mkdir -p /workspace.
    expect(mockState.execCalls[0]).toMatchObject({
      Cmd: ["/bin/sh", "-c", `mkdir -p ${SANDBOX_WORKSPACE_ROOT}`],
    });
  });

  it("createContainer is called with the right config", async () => {
    setupFreshProvision();
    queueExec({ exitCode: 0 });

    const backend = createDockerSandboxBackend({}, {});
    await backend.shellExec(ctx, { command: "true" });

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
    expect(opts.HostConfig?.Memory).toBe(2 * 1024 * 1024 * 1024);
    expect(opts.HostConfig?.MemorySwap).toBe(opts.HostConfig?.Memory);
    expect(opts.HostConfig?.NanoCpus).toBe(2_000_000_000);
    expect(opts.HostConfig?.SecurityOpt).toEqual(["no-new-privileges:true"]);
    // Default-deny host reachability (ADR-0005): empty config → no reachability.
    expect(opts.HostConfig?.ExtraHosts).toEqual([]);
    expect(opts.HostConfig?.NetworkMode).toBeUndefined();
  });

  it("reuses an existing running container without re-creating", async () => {
    // existingContainer present; its inspect() will resolve Running=true.
    mockState.existingContainer = makeFakeContainer();
    // First inspect returns running.
    mockState.containerInspects.push(() =>
      Promise.resolve({ State: { Running: true } }),
    );
    queueExec({ stdout: "ok", exitCode: 0 });

    const backend = createDockerSandboxBackend({}, {});
    await backend.shellExec(ctx, { command: "true" });

    expect(mockState.createContainerCalls).toHaveLength(0);
    expect(mockState.createVolumeCalls).toHaveLength(0);
    expect(mockState.pullCalls).toHaveLength(0);
    expect(mockState.imageInspects).toHaveLength(0); // none consumed
  });

  it("starts an existing stopped container", async () => {
    mockState.existingContainer = makeFakeContainer();
    mockState.containerInspects.push(() =>
      Promise.resolve({ State: { Running: false } }),
    );
    queueExec({ exitCode: 0 });

    const backend = createDockerSandboxBackend({}, {});
    await backend.shellExec(ctx, { command: "true" });

    expect(mockState.existingContainer.start).toHaveBeenCalledTimes(1);
    expect(mockState.createContainerCalls).toHaveLength(0);
  });

  it("in-flight memoisation: concurrent calls share one provisioning", async () => {
    setupFreshProvision();
    // Two parallel tool calls share the same provisioning. Each needs its own exec slot.
    queueExec({ exitCode: 0 });
    queueExec({ exitCode: 0 });

    const backend = createDockerSandboxBackend({}, {});
    await Promise.all([
      backend.shellExec(ctx, { command: "a" }),
      backend.shellExec(ctx, { command: "b" }),
    ]);

    expect(mockState.createContainerCalls).toHaveLength(1);
  });
});

describe("DockerSandboxTransport — argv safety", () => {
  it("fsRead passes shell-metachar path as literal argv", async () => {
    setupFreshProvision();
    queueExec({ stdout: "data", exitCode: 0 });

    const backend = createDockerSandboxBackend({}, {});
    const malicious = `foo";rm -rf /`;
    await backend.fsRead(ctx, { path: malicious });

    // Find the fsRead exec call — last call (after provisioning mkdir).
    const last = mockState.execCalls.at(-1) as { Cmd: string[] };
    expect(last.Cmd).toEqual(["cat", "--", `/workspace/${malicious}`]);
  });

  it("fsRead bounds the cat output at the cap core asked for", async () => {
    // `cat` will happily emit a gigabyte; the stdout cap is what keeps a huge
    // file from being buffered whole. Whether a filled buffer counts as
    // truncated is core's rule, tested in sandbox/posix.test.ts.
    setupFreshProvision();
    queueExec({ stdout: "a".repeat(MAX_READ_BYTES + 5_000), exitCode: 0 });

    const backend = createDockerSandboxBackend({}, {});
    const res = await backend.fsRead(ctx, { path: "big.txt" });

    expect(res.content).toHaveLength(MAX_READ_BYTES);
  });

  it("fsList hands core's find argv to dockerode unmodified", async () => {
    // Pre-warm with a running container so the find exec is the only one and
    // execCalls[0] is unambiguous.
    mockState.existingContainer = makeFakeContainer();
    mockState.containerInspects.push(() =>
      Promise.resolve({ State: { Running: true } }),
    );
    queueExec({ stdout: "", exitCode: 0 });

    const backend = createDockerSandboxBackend({}, {});
    await backend.fsList(ctx, { glob: "**/*.ts" });

    // What the glob rules *are* is core's business (posix.test.ts). What this
    // asserts is that the transport adds no shell and re-quotes nothing: the
    // argv core built arrives at the daemon element for element.
    const call = mockState.execCalls[0] as { Cmd: string[] };
    expect(call.Cmd).toEqual(
      buildFindArgs(SANDBOX_WORKSPACE_ROOT, { glob: "**/*.ts" }),
    );
  });

  it("fsWrite create-mode probes with [test, -e, <path>] and throws if exists", async () => {
    setupFreshProvision();
    // probe — file exists (exit 0).
    queueExec({ exitCode: 0 });

    const backend = createDockerSandboxBackend({}, {});
    await expect(
      backend.fsWrite(ctx, {
        path: "foo",
        content: "bar",
        mode: "create",
      }),
    ).rejects.toThrow(/already exists/);

    const probeCall = mockState.execCalls.at(-1) as { Cmd: string[] };
    expect(probeCall.Cmd).toEqual(["test", "-e", "/workspace/foo"]);
  });

  it("fsWrite overwrite mode skips the probe and calls putArchive", async () => {
    // Pre-warm with an existing running container so we can isolate exec calls
    // from the fsWrite itself.
    mockState.existingContainer = makeFakeContainer();
    mockState.containerInspects.push(() =>
      Promise.resolve({ State: { Running: true } }),
    );

    const backend = createDockerSandboxBackend({}, {});
    await backend.fsWrite(ctx, {
      path: "foo.txt",
      content: "hello",
      mode: "overwrite",
    });
    // No exec calls at all: no probe (overwrite skips), no mkdir (top-level path).
    expect(mockState.execCalls.length).toBe(0);
    expect(mockState.putArchiveCalls).toHaveLength(1);
    expect(mockState.putArchiveCalls[0].opts).toEqual({ path: "/workspace" });
  });
});

describe("DockerSandboxTransport — tar builder", () => {
  it("buildSingleFileTar produces a parseable ustar archive", () => {
    const content = Buffer.from("hello world", "utf8");
    const tar = buildSingleFileTar("a/b.txt", content);

    expect(tar.length % 512).toBe(0);
    // ustar magic at offset 257.
    expect(tar.slice(257, 262).toString("utf8")).toBe("ustar");

    // size field at 124..136 — 11 octal digits + space.
    const sizeField = tar.slice(124, 136).toString("utf8");
    // Octal-encoded content length, zero-padded to 11, trailing space.
    const expectedSize = content.length.toString(8).padStart(11, "0") + " ";
    expect(sizeField).toBe(expectedSize);

    // Entry name at offset 0..100, NUL-padded.
    const nameBytes = tar.slice(0, 100);
    const nul = nameBytes.indexOf(0);
    const name = nameBytes.slice(0, nul === -1 ? 100 : nul).toString("utf8");
    expect(name).toBe("a/b.txt");
  });

  it("buildSingleFileTar strips leading slashes from entry name", () => {
    const tar = buildSingleFileTar("/leading", Buffer.from("x"));
    const nameBytes = tar.slice(0, 100);
    const nul = nameBytes.indexOf(0);
    expect(nameBytes.slice(0, nul).toString("utf8")).toBe("leading");
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

  it("logs but proceeds when stop returns 500", async () => {
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
    expect(removeCalled).toBe(true);
    expect(volRemoveCalled).toBe(true);
  });
});

describe("DockerSandboxTransport — shellExec output handling", () => {
  it("times out: returns exitCode 124 and destroys the stream", async () => {
    setupFreshProvision();
    // Long-running exec — close after 200ms; timeout will be 20ms.
    queueExec({ closeDelayMs: 200, exitCode: 0 });

    const backend = createDockerSandboxBackend({}, {});
    const res = await backend.shellExec(ctx, {
      command: "sleep 5",
      timeoutMs: 20,
    });

    expect(res.exitCode).toBe(124);
  });

  it("caps stdout at MAX_SHELL_OUTPUT_BYTES and flags truncated", async () => {
    setupFreshProvision();
    const huge = "a".repeat(MAX_SHELL_OUTPUT_BYTES + 5_000);
    queueExec({ stdout: huge, exitCode: 0 });

    const backend = createDockerSandboxBackend({}, {});
    const res = await backend.shellExec(ctx, { command: "yes" });

    expect(res.stdout.length).toBe(MAX_SHELL_OUTPUT_BYTES);
    expect(res.truncated).toBe(true);
  });
});

describe("DockerSandboxTransport — host reachability (ADR-0005)", () => {
  it("applies configured extraHosts to HostConfig.ExtraHosts", async () => {
    setupFreshProvision();
    queueExec({ exitCode: 0 });

    const backend = createDockerSandboxBackend(
      { extraHosts: ["host.docker.internal:host-gateway"] },
      {},
    );
    await backend.shellExec(ctx, { command: "true" });

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
    );
    await backend.shellExec(ctx, { command: "true" });

    expect(mockState.createContainerCalls[0].HostConfig?.NetworkMode).toBe(
      "primary",
    );
    expect(mockState.networkConnectCalls.map((c) => c.network)).toEqual([
      "secondary",
      "tertiary",
    ]);
    // Each connect targets a container id via the Container option.
    expect(
      mockState.networkConnectCalls.every((c) => "Container" in c.opts),
    ).toBe(true);
  });

  it("a single network sets NetworkMode and makes no connect calls", async () => {
    setupFreshProvision();
    queueExec({ exitCode: 0 });

    const backend = createDockerSandboxBackend({ networks: ["only"] }, {});
    await backend.shellExec(ctx, { command: "true" });

    expect(mockState.createContainerCalls[0].HostConfig?.NetworkMode).toBe(
      "only",
    );
    expect(mockState.networkConnectCalls).toHaveLength(0);
  });

  // The per-Workspace config schema is now a factory of the plugin's resolved
  // deploy-time config (ADR-0013): the operator allowlist arrives as
  // `allowedNetworks`, no longer from process.env.
  describe("dockerSandboxConfigSchema (factory of plugin config)", () => {
    it("defaults to empty arrays for {}", () => {
      const parsed = dockerSandboxConfigSchema({ allowedNetworks: [] }).parse(
        {},
      );
      expect(parsed).toEqual({ networks: [], extraHosts: [] });
    });

    it("accepts networks that are in the operator allowlist", () => {
      const parsed = dockerSandboxConfigSchema({
        allowedNetworks: ["shared", "tools"],
      }).parse({ networks: ["shared"] });
      expect(parsed.networks).toEqual(["shared"]);
    });

    it("rejects networks outside the operator allowlist", () => {
      const result = dockerSandboxConfigSchema({
        allowedNetworks: ["shared"],
      }).safeParse({ networks: ["not-allowed"] });
      expect(result.success).toBe(false);
    });

    it("rejects any network under an empty allowlist (default-deny)", () => {
      const result = dockerSandboxConfigSchema({
        allowedNetworks: [],
      }).safeParse({ networks: ["shared"] });
      expect(result.success).toBe(false);
    });

    it("names the plugin-config allowlist source in the error", () => {
      const result = dockerSandboxConfigSchema({
        allowedNetworks: [],
      }).safeParse({ networks: ["nope"] });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain(
          "@platypus/docker plugin config 'allowedNetworks'",
        );
      }
    });

    it("rejects malformed extraHosts entries", () => {
      const result = dockerSandboxConfigSchema({
        allowedNetworks: [],
      }).safeParse({ extraHosts: ["not a valid entry"] });
      expect(result.success).toBe(false);
    });
  });
});

describe("DockerSandboxTransport — plugin-injected logger", () => {
  // Core binds the injected logger to the manifest name before handing it over,
  // so a line written through it is already attributed — which is why these
  // assertions check the *fields the call site supplies* and never a `plugin`
  // key of their own.

  it("writes the image-pull line to the injected logger, not core's", async () => {
    setupFreshProvision();
    queueExec({ stdout: "hi", exitCode: 0 });
    const backend = createDockerSandboxBackend({}, {}, withPluginLogger());
    await backend.shellExec(ctx, { command: "echo hi" });

    expect(mockState.pullCalls).toEqual(["debian:stable-slim"]);
    // Same fields and message as before the routing change.
    expect(pluginLogger.info).toHaveBeenCalledWith(
      { image: "debian:stable-slim" },
      "Pulling sandbox image",
    );
    // The whole point: core's logger is no longer the adapter's channel.
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("writes the destroy() warnings to the injected logger, not core's", async () => {
    mockState.existingContainer = makeFakeContainer();
    mockState.containerStop = () =>
      Promise.reject(makeStatusError("internal", 500));
    const backend = createDockerSandboxBackend({}, {}, withPluginLogger());
    await backend.destroy(ctx);

    expect(pluginLogger.warn).toHaveBeenCalledTimes(1);
    expect(pluginLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-abc" }),
      "sandbox destroy: stop failed (continuing)",
    );
    expect(logger.warn).not.toHaveBeenCalled();
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

    // All three still fire, at warn, with their original wording — teardown is
    // best-effort and each step reports independently.
    expect(pluginLogger.warn.mock.calls.map((c) => c[1])).toEqual([
      "sandbox destroy: stop failed (continuing)",
      "sandbox destroy: container remove failed (continuing)",
      "sandbox destroy: volume remove failed",
    ]);
  });

  it("degrades to silence when core injects no logger", async () => {
    // `PluginConfigContext.logger` is optional under the SDK's append-only
    // policy, so the adapter must not assume it. Core always supplies it; a
    // directly-constructed adapter does not, and that must not throw.
    mockState.existingContainer = makeFakeContainer();
    mockState.containerStop = () =>
      Promise.reject(makeStatusError("internal", 500));

    const backend = createDockerSandboxBackend({}, {});
    await expect(backend.destroy(ctx)).resolves.toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("reaches the adapter through the manifest's create()", async () => {
    // The full contribution path core uses: the loader calls `create` with the
    // plugin block as its third argument, and the manifest must forward it.
    setupFreshProvision();
    queueExec({ stdout: "hi", exitCode: 0 });
    const contribution = plugin.contributes.sandboxBackends![0];
    const backend = contribution.create({}, {}, withPluginLogger());
    await backend.shellExec(ctx, { command: "echo hi" });

    expect(pluginLogger.info).toHaveBeenCalledWith(
      { image: "debian:stable-slim" },
      "Pulling sandbox image",
    );
  });

  it("carries the manifest name on its lines when loaded by the real loader", async () => {
    // End to end through the path production takes — loader → deploy-time block
    // → `create` → transport — because that is the only thing that proves the
    // *attribution*. Every other test in this suite supplies its own logger and
    // so would pass even if the loader bound the wrong name, or none. What an
    // Operator greps for is `"plugin":"@platypus/docker"`, and this is the test
    // that fails if that stops being what they get.
    setupFreshProvision();
    queueExec({ stdout: "hi", exitCode: 0 });

    // Stands in for core's logger: records the bindings each child is made with
    // and merges them into every line that child writes, exactly as pino does.
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

    // A capturing registrar so this load does not collide with the
    // module-global sandbox registry other suites in this file seed.
    const captured: SandboxBackendContribution[] = [];
    await loadPlugins({
      pluginNames: ["@platypus/docker"],
      registerSandbox: (c) => captured.push(c),
      baseLogger,
    });

    const backend = captured[0].create({}, {});
    await backend.shellExec(ctx, { command: "echo hi" });

    expect(lines).toContainEqual({
      bindings: { plugin: "@platypus/docker", level: "info" },
      fields: { image: "debian:stable-slim" },
      msg: "Pulling sandbox image",
    });
  });
});
