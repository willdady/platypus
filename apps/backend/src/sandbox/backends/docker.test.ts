import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PassThrough } from "node:stream";

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
  modem: { demuxStream: (...args: any[]) => void };
};

type ExecConfig = {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  exitCode?: number;
  /** Delay (ms) before stream closes — used to test timeout behaviour. */
  closeDelayMs?: number;
};

type MockState = {
  // Sequence of behaviours for container.inspect() — popped left-to-right.
  containerInspects: Array<() => Promise<any>>;
  // Sequence for image.inspect().
  imageInspects: Array<() => Promise<any>>;
  // Sequence for volume.inspect().
  volumeInspects: Array<() => Promise<any>>;
  // Sequence of exec behaviours, popped on each exec.
  execQueue: ExecConfig[];
  // Recorded calls.
  createContainerCalls: any[];
  createVolumeCalls: any[];
  putArchiveCalls: Array<{ buffer: Buffer; opts: any }>;
  execCalls: any[];
  pullCalls: any[];
  // Per-container stop/remove handlers (keyed by container name).
  containerStop: () => Promise<any>;
  containerRemove: () => Promise<any>;
  volumeRemove: () => Promise<any>;
  // Track last container so tests can assert .start() was called.
  lastContainer: FakeContainer | null;
  // Track the *existing* container (returned by getContainer before create).
  existingContainer: FakeContainer | null;
};

let mockState: MockState;

function makeFakeContainer(): FakeContainer {
  const demuxStream = (stream: any, stdoutPass: any, stderrPass: any) => {
    // Read the most recently configured exec output (set on exec.start()).
    const cfg = (stream as any).__execCfg as ExecConfig | undefined;
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
    inspect: vi.fn(async () => {
      const next = mockState.containerInspects.shift();
      if (!next) {
        // Default: container running.
        return { State: { Running: true } };
      }
      return next();
    }),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => mockState.containerStop()),
    remove: vi.fn(async () => mockState.containerRemove()),
    exec: vi.fn(async (opts: any) => {
      mockState.execCalls.push(opts);
      const cfg: ExecConfig = mockState.execQueue.shift() ?? {};
      const stream = new PassThrough();
      (stream as any).__execCfg = cfg;
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
      return {
        start: vi.fn(async () => stream),
        inspect: vi.fn(async () => ({ ExitCode: cfg.exitCode ?? 0 })),
      };
    }),
    putArchive: vi.fn(async (buffer: Buffer, opts: any) => {
      mockState.putArchiveCalls.push({ buffer, opts });
    }),
    modem: { demuxStream },
  };
  return container;
}

vi.mock("dockerode", () => {
  class Docker {
    modem: { followProgress: (...args: any[]) => void; demuxStream: any };

    constructor() {
      this.modem = {
        followProgress: (_stream: any, cb: (err: Error | null) => void) => {
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
        inspect: vi.fn(async () => {
          const next = mockState.imageInspects.shift();
          if (!next) return { Id: "sha256:abc" };
          return next();
        }),
      };
    }

    getVolume(_name: string) {
      return {
        inspect: vi.fn(async () => {
          const next = mockState.volumeInspects.shift();
          if (!next) return { Name: _name };
          return next();
        }),
        remove: vi.fn(async () => mockState.volumeRemove()),
      };
    }

    createContainer(opts: any) {
      mockState.createContainerCalls.push(opts);
      const c = makeFakeContainer();
      mockState.lastContainer = c;
      // After creation, getContainer() should return this same container.
      return c;
    }

    createVolume(opts: any) {
      mockState.createVolumeCalls.push(opts);
      return {};
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
import { DockerSandboxBackend, buildSingleFileTar } from "./docker.ts";
import { logger } from "../../logger.ts";
import { MAX_SHELL_OUTPUT_BYTES, SANDBOX_WORKSPACE_ROOT } from "../index.ts";
import type { SandboxContext } from "../types.ts";

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
    containerStop: async () => undefined,
    containerRemove: async () => undefined,
    volumeRemove: async () => undefined,
    lastContainer: null,
    existingContainer: null,
  };
}

// Helpers for setting up exec output sequences.
function queueExec(cfg: ExecConfig = {}) {
  mockState.execQueue.push(cfg);
}

/** Configure container.inspect() to reject 404 (no such container). */
function setContainerMissing() {
  mockState.containerInspects.push(async () => {
    const err: any = new Error("no such container");
    err.statusCode = 404;
    throw err;
  });
}

function setImageMissing() {
  mockState.imageInspects.push(async () => {
    const err: any = new Error("no such image");
    err.statusCode = 404;
    throw err;
  });
}

function setVolumeMissing() {
  mockState.volumeInspects.push(async () => {
    const err: any = new Error("no such volume");
    err.statusCode = 404;
    throw err;
  });
}

/** Configure a fresh provisioning path: every check returns 404 until create. */
function setupFreshProvision() {
  setContainerMissing();
  setImageMissing();
  setVolumeMissing();
  // After provisioning, the mkdir -p workspace exec is invoked.
  queueExec({ exitCode: 0 });
}

beforeEach(() => {
  resetMockState();
  vi.clearAllMocks();
});

describe("DockerSandboxBackend — provisioning", () => {
  it("provisions a new container when none exists", async () => {
    setupFreshProvision();
    // Plus an exec for the actual tool call.
    queueExec({ stdout: "hi", exitCode: 0 });

    const backend = new DockerSandboxBackend({}, {});
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

    const backend = new DockerSandboxBackend({}, {});
    await backend.shellExec(ctx, { command: "true" });

    const opts = mockState.createContainerCalls[0];
    expect(opts.name).toBe("platypus-sandbox-ws-abc");
    expect(opts.Image).toBe("debian:stable-slim");
    expect(opts.Cmd).toEqual(["sleep", "infinity"]);
    expect(opts.WorkingDir).toBe("/workspace");
    expect(opts.Labels["platypus.sandbox"]).toBe("true");
    expect(opts.Labels["platypus.sandbox.workspaceId"]).toBe("ws-abc");
    expect(opts.HostConfig.Binds).toEqual([
      "platypus-sandbox-vol-ws-abc:/workspace",
    ]);
    expect(opts.HostConfig.PidsLimit).toBe(256);
    expect(opts.HostConfig.Memory).toBe(2 * 1024 * 1024 * 1024);
    expect(opts.HostConfig.MemorySwap).toBe(opts.HostConfig.Memory);
    expect(opts.HostConfig.NanoCpus).toBe(2_000_000_000);
    expect(opts.HostConfig.SecurityOpt).toEqual(["no-new-privileges:true"]);
    expect(opts.HostConfig.ExtraHosts).toEqual([
      "host.docker.internal:host-gateway",
    ]);
  });

  describe("PLATYPUS_SANDBOX_EXTRA_HOSTS", () => {
    const originalEnv = process.env.PLATYPUS_SANDBOX_EXTRA_HOSTS;

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.PLATYPUS_SANDBOX_EXTRA_HOSTS;
      } else {
        process.env.PLATYPUS_SANDBOX_EXTRA_HOSTS = originalEnv;
      }
    });

    it("opts out of ExtraHosts entirely when set to empty string", async () => {
      process.env.PLATYPUS_SANDBOX_EXTRA_HOSTS = "";
      setupFreshProvision();
      queueExec({ exitCode: 0 });

      const backend = new DockerSandboxBackend({}, {});
      await backend.shellExec(ctx, { command: "true" });

      expect(mockState.createContainerCalls[0].HostConfig.ExtraHosts).toEqual(
        [],
      );
    });

    it("replaces default with a custom comma-separated list", async () => {
      process.env.PLATYPUS_SANDBOX_EXTRA_HOSTS =
        "host.docker.internal:host-gateway, internal.example:10.0.0.5";
      setupFreshProvision();
      queueExec({ exitCode: 0 });

      const backend = new DockerSandboxBackend({}, {});
      await backend.shellExec(ctx, { command: "true" });

      expect(mockState.createContainerCalls[0].HostConfig.ExtraHosts).toEqual([
        "host.docker.internal:host-gateway",
        "internal.example:10.0.0.5",
      ]);
    });

    it("throws on malformed entries", async () => {
      process.env.PLATYPUS_SANDBOX_EXTRA_HOSTS = "not a valid entry";
      setupFreshProvision();

      const backend = new DockerSandboxBackend({}, {});
      await expect(backend.shellExec(ctx, { command: "true" })).rejects.toThrow(
        /PLATYPUS_SANDBOX_EXTRA_HOSTS/,
      );
    });
  });

  it("reuses an existing running container without re-creating", async () => {
    // existingContainer present; its inspect() will resolve Running=true.
    mockState.existingContainer = makeFakeContainer();
    // First inspect returns running.
    mockState.containerInspects.push(async () => ({
      State: { Running: true },
    }));
    queueExec({ stdout: "ok", exitCode: 0 });

    const backend = new DockerSandboxBackend({}, {});
    await backend.shellExec(ctx, { command: "true" });

    expect(mockState.createContainerCalls).toHaveLength(0);
    expect(mockState.createVolumeCalls).toHaveLength(0);
    expect(mockState.pullCalls).toHaveLength(0);
    expect(mockState.imageInspects).toHaveLength(0); // none consumed
  });

  it("starts an existing stopped container", async () => {
    mockState.existingContainer = makeFakeContainer();
    mockState.containerInspects.push(async () => ({
      State: { Running: false },
    }));
    queueExec({ exitCode: 0 });

    const backend = new DockerSandboxBackend({}, {});
    await backend.shellExec(ctx, { command: "true" });

    expect(mockState.existingContainer.start).toHaveBeenCalledTimes(1);
    expect(mockState.createContainerCalls).toHaveLength(0);
  });

  it("in-flight memoisation: concurrent calls share one provisioning", async () => {
    setupFreshProvision();
    // Two parallel tool calls share the same provisioning. Each needs its own exec slot.
    queueExec({ exitCode: 0 });
    queueExec({ exitCode: 0 });

    const backend = new DockerSandboxBackend({}, {});
    await Promise.all([
      backend.shellExec(ctx, { command: "a" }),
      backend.shellExec(ctx, { command: "b" }),
    ]);

    expect(mockState.createContainerCalls).toHaveLength(1);
  });
});

describe("DockerSandboxBackend — argv safety", () => {
  it("fsRead passes shell-metachar path as literal argv", async () => {
    setupFreshProvision();
    queueExec({ stdout: "data", exitCode: 0 });

    const backend = new DockerSandboxBackend({}, {});
    const malicious = `foo";rm -rf /`;
    await backend.fsRead(ctx, { path: malicious });

    // Find the fsRead exec call — last call (after provisioning mkdir).
    const last = mockState.execCalls.at(-1);
    expect(last.Cmd).toEqual(["cat", "--", `/workspace/${malicious}`]);
  });

  it("fsList simple glob uses -name", async () => {
    setupFreshProvision();
    queueExec({ stdout: "", exitCode: 0 });

    const backend = new DockerSandboxBackend({}, {});
    await backend.fsList(ctx, { glob: "*.ts" });

    const last = mockState.execCalls.at(-1);
    const idx = last.Cmd.indexOf("-name");
    expect(idx).toBeGreaterThan(-1);
    expect(last.Cmd[idx + 1]).toBe("*.ts");
  });

  it("fsList glob with slash uses -path */<glob>", async () => {
    setupFreshProvision();
    queueExec({ stdout: "", exitCode: 0 });

    const backend = new DockerSandboxBackend({}, {});
    await backend.fsList(ctx, { glob: "src/*.ts" });

    const last = mockState.execCalls.at(-1);
    const idx = last.Cmd.indexOf("-path");
    expect(idx).toBeGreaterThan(-1);
    expect(last.Cmd[idx + 1]).toBe("*/src/*.ts");
  });

  it("fsList glob with ** collapses ** to * for find", async () => {
    setupFreshProvision();
    queueExec({ stdout: "", exitCode: 0 });

    const backend = new DockerSandboxBackend({}, {});
    await backend.fsList(ctx, { glob: "**/*.ts" });

    const last = mockState.execCalls.at(-1);
    const idx = last.Cmd.indexOf("-path");
    expect(idx).toBeGreaterThan(-1);
    expect(last.Cmd[idx + 1]).toBe("*/*/*.ts");
  });

  it("fsWrite create-mode probes with [test, -e, <path>] and throws if exists", async () => {
    setupFreshProvision();
    // probe — file exists (exit 0).
    queueExec({ exitCode: 0 });

    const backend = new DockerSandboxBackend({}, {});
    await expect(
      backend.fsWrite(ctx, {
        path: "foo",
        content: "bar",
        mode: "create",
      }),
    ).rejects.toThrow(/already exists/);

    const probeCall = mockState.execCalls.at(-1);
    expect(probeCall.Cmd).toEqual(["test", "-e", "/workspace/foo"]);
  });

  it("fsWrite overwrite mode skips the probe and calls putArchive", async () => {
    // Pre-warm with an existing running container so we can isolate exec calls
    // from the fsWrite itself.
    mockState.existingContainer = makeFakeContainer();
    mockState.containerInspects.push(async () => ({
      State: { Running: true },
    }));

    const backend = new DockerSandboxBackend({}, {});
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

describe("DockerSandboxBackend — tar builder", () => {
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

describe("DockerSandboxBackend — destroy() idempotence", () => {
  it("swallows 404 on stop and proceeds to remove + volume remove", async () => {
    mockState.existingContainer = makeFakeContainer();
    mockState.containerStop = async () => {
      const err: any = new Error("no such container");
      err.statusCode = 404;
      throw err;
    };

    const backend = new DockerSandboxBackend({}, {});
    await expect(backend.destroy(ctx)).resolves.toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("swallows 304 (already stopped) on stop", async () => {
    mockState.existingContainer = makeFakeContainer();
    mockState.containerStop = async () => {
      const err: any = new Error("already stopped");
      err.statusCode = 304;
      throw err;
    };

    const backend = new DockerSandboxBackend({}, {});
    await expect(backend.destroy(ctx)).resolves.toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("swallows 404 on container remove and on volume remove", async () => {
    mockState.existingContainer = makeFakeContainer();
    const mkErr = () => {
      const err: any = new Error("not found");
      err.statusCode = 404;
      throw err;
    };
    mockState.containerRemove = async () => mkErr();
    mockState.volumeRemove = async () => mkErr();

    const backend = new DockerSandboxBackend({}, {});
    await expect(backend.destroy(ctx)).resolves.toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs but proceeds when stop returns 500", async () => {
    mockState.existingContainer = makeFakeContainer();
    mockState.containerStop = async () => {
      const err: any = new Error("internal");
      err.statusCode = 500;
      throw err;
    };
    let removeCalled = false;
    mockState.containerRemove = async () => {
      removeCalled = true;
    };
    let volRemoveCalled = false;
    mockState.volumeRemove = async () => {
      volRemoveCalled = true;
    };

    const backend = new DockerSandboxBackend({}, {});
    await backend.destroy(ctx);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(removeCalled).toBe(true);
    expect(volRemoveCalled).toBe(true);
  });
});

describe("DockerSandboxBackend — shellExec output handling", () => {
  it("times out: returns exitCode 124 and destroys the stream", async () => {
    setupFreshProvision();
    // Long-running exec — close after 200ms; timeout will be 20ms.
    queueExec({ closeDelayMs: 200, exitCode: 0 });

    const backend = new DockerSandboxBackend({}, {});
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

    const backend = new DockerSandboxBackend({}, {});
    const res = await backend.shellExec(ctx, { command: "yes" });

    expect(res.stdout.length).toBe(MAX_SHELL_OUTPUT_BYTES);
    expect(res.truncated).toBe(true);
  });
});

describe("DockerSandboxBackend — fsEdit error cases", () => {
  it("throws when oldString is missing from file", async () => {
    setupFreshProvision();
    queueExec({ stdout: "the original content here", exitCode: 0 });

    const backend = new DockerSandboxBackend({}, {});
    await expect(
      backend.fsEdit(ctx, {
        path: "file.txt",
        oldString: "does-not-appear",
        newString: "x",
      }),
    ).rejects.toThrow(/oldString not found/);
  });

  it("throws when oldString is not unique", async () => {
    setupFreshProvision();
    queueExec({ stdout: "abc abc", exitCode: 0 });

    const backend = new DockerSandboxBackend({}, {});
    await expect(
      backend.fsEdit(ctx, {
        path: "file.txt",
        oldString: "abc",
        newString: "x",
      }),
    ).rejects.toThrow(/not unique/);
  });
});
