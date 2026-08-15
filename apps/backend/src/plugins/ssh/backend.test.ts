import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock ssh2. `new Client()` returns a fake EventEmitter-based client. connect()
// emits "ready" (or "error"); exec() invokes its callback with a fake channel
// that emits data/exit/close. Happy-path emissions are synchronous (so awaits
// resolve without needing timer advancement); a `closeDelayMs` uses a real
// timer to exercise the timeout path. State is pulled from `mockState`.
// ---------------------------------------------------------------------------

type ExecConfig = {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  exitCode?: number;
  /** Delay (ms) before the channel emits + closes — used for the timeout test. */
  closeDelayMs?: number;
};

type MockState = {
  connectConfigs: Record<string, unknown>[];
  execCommands: string[];
  execQueue: ExecConfig[];
  // stdout returned for the connect-time root-resolution exec.
  resolvedRoot: string;
  // When set, connect() emits this error instead of "ready".
  connectShouldFail: Error | null;
  // When true, the connect-time root-resolution exec exits non-zero.
  rootCreateFails: boolean;
  // Count of client.end() calls (disconnects).
  ended: number;
  // In-memory SFTP filesystem (absolute host paths). `files` maps a path to its
  // byte content; `dirs` is the set of existing directories. Handles are minted
  // by open() and carry the path + flag they were opened with.
  files: Map<string, Buffer>;
  dirs: Set<string>;
  handles: Map<number, { path: string; flag: string }>;
  nextHandle: number;
  // Count of client.sftp() calls (SFTP subsystem opens).
  sftpOpens: number;
  // When set, client.sftp() invokes its callback with this error.
  sftpShouldFail: Error | null;
  // The raw host-key blob the fake server presents to a configured
  // hostVerifier. When a verifier is present and rejects it, connect() emits an
  // "error" instead of "ready" (mirroring ssh2's handshake failure).
  presentedHostKey: Buffer | null;
};

// The factory closure reads `mockState` lazily (at call time), by which point
// beforeEach has assigned it — so a plain `let` is fine.
let mockState: MockState;

// The Client class is defined INSIDE the factory: a top-level `class` would be
// in the TDZ when the hoisted factory runs, and a top-level `import` binding is
// likewise uninitialised at that point (vi.mock hoists above imports). So
// EventEmitter is required inside the factory, cast to its real type to keep the
// fakes fully typed.
vi.mock("ssh2", () => {
  const { EventEmitter } =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("node:events") as typeof import("node:events");

  const toBuf = (v: string | Buffer): Buffer =>
    typeof v === "string" ? Buffer.from(v, "utf8") : v;

  class FakeChannel extends EventEmitter {
    stderr = new EventEmitter();
    closed = false;

    // Adapter calls this on timeout to close the channel.
    close(): void {
      if (this.closed) return;
      this.closed = true;
      this.emit("close");
    }

    destroy(): this {
      this.close();
      return this;
    }
  }

  // A minimal in-memory SFTP subsystem backed by mockState. Handles are 4-byte
  // buffers encoding an integer id; the id maps to the opened path + flag. Only
  // the primitives the adapter calls are implemented.
  const encodeHandle = (id: number): Buffer => {
    const h = Buffer.alloc(4);
    h.writeUInt32BE(id, 0);
    return h;
  };
  const handleId = (handle: Buffer): number => handle.readUInt32BE(0);

  class FakeSFTP extends EventEmitter {
    stat(
      path: string,
      cb: (err: Error | undefined, stats?: { size: number }) => void,
    ): void {
      if (mockState.files.has(path)) {
        cb(undefined, { size: mockState.files.get(path)!.length });
      } else if (mockState.dirs.has(path)) {
        cb(undefined, { size: 0 });
      } else {
        cb(new Error("No such file"));
      }
    }

    mkdir(path: string, cb: (err?: Error) => void): void {
      if (mockState.dirs.has(path) || mockState.files.has(path)) {
        cb(new Error("Failure: already exists"));
        return;
      }
      mockState.dirs.add(path);
      cb(undefined);
    }

    open(
      path: string,
      flag: string,
      cb: (err: Error | undefined, handle?: Buffer) => void,
    ): void {
      if (flag === "r") {
        if (!mockState.files.has(path)) {
          cb(new Error("No such file"));
          return;
        }
      } else if (flag === "wx") {
        if (mockState.files.has(path)) {
          cb(new Error("Failure: file already exists"));
          return;
        }
        mockState.files.set(path, Buffer.alloc(0));
      } else {
        // "w" — truncate-or-create.
        mockState.files.set(path, Buffer.alloc(0));
      }
      const id = mockState.nextHandle++;
      mockState.handles.set(id, { path, flag });
      cb(undefined, encodeHandle(id));
    }

    close(handle: Buffer, cb: (err?: Error) => void): void {
      mockState.handles.delete(handleId(handle));
      cb(undefined);
    }

    fstat(
      handle: Buffer,
      cb: (err: Error | undefined, stats?: { size: number }) => void,
    ): void {
      const h = mockState.handles.get(handleId(handle));
      const buf = h ? (mockState.files.get(h.path) ?? Buffer.alloc(0)) : null;
      if (!buf) {
        cb(new Error("Invalid handle"));
        return;
      }
      cb(undefined, { size: buf.length });
    }

    read(
      handle: Buffer,
      buf: Buffer,
      off: number,
      len: number,
      position: number,
      cb: (err: Error | undefined, bytesRead: number, buffer: Buffer) => void,
    ): void {
      const h = mockState.handles.get(handleId(handle))!;
      const content = mockState.files.get(h.path) ?? Buffer.alloc(0);
      const slice = content.subarray(position, position + len);
      slice.copy(buf, off);
      cb(undefined, slice.length, buf);
    }

    write(
      handle: Buffer,
      buf: Buffer,
      off: number,
      len: number,
      position: number,
      cb: (err?: Error) => void,
    ): void {
      const h = mockState.handles.get(handleId(handle))!;
      let content = mockState.files.get(h.path) ?? Buffer.alloc(0);
      const end = position + len;
      if (content.length < end) {
        const grown = Buffer.alloc(end);
        content.copy(grown);
        content = grown;
      }
      buf.copy(content, position, off, off + len);
      mockState.files.set(h.path, content);
      cb(undefined);
    }
  }

  class FakeClient extends EventEmitter {
    connect(config: Record<string, unknown>): this {
      mockState.connectConfigs.push(config);
      // Listeners are registered by the adapter before connect() is called, so
      // a synchronous emit is safe and keeps awaits resolving via microtasks.
      if (mockState.connectShouldFail) {
        this.emit("error", mockState.connectShouldFail);
        return this;
      }
      // Honour a configured hostVerifier (sync form: returns boolean). ssh2
      // presents the raw key blob during the handshake; a false result aborts
      // with a handshake error rather than reaching "ready".
      const verifier = config.hostVerifier as
        ((key: Buffer) => boolean) | undefined;
      if (typeof verifier === "function") {
        const presented = mockState.presentedHostKey ?? Buffer.alloc(0);
        if (!verifier(presented)) {
          this.emit("error", new Error("Handshake failed: host key rejected"));
          return this;
        }
      }
      this.emit("ready");
      return this;
    }

    exec(
      command: string,
      cb: (err: Error | undefined, channel: FakeChannel) => void,
    ): this {
      mockState.execCommands.push(command);
      const isResolve = command.includes('printf %s "$ROOT"');
      const cfg: ExecConfig = isResolve
        ? {
            stdout: mockState.resolvedRoot,
            stderr: mockState.rootCreateFails ? "permission denied" : undefined,
            exitCode: mockState.rootCreateFails ? 1 : 0,
          }
        : (mockState.execQueue.shift() ?? { exitCode: 0 });

      const channel = new FakeChannel();
      cb(undefined, channel);

      const emit = () => {
        if (channel.closed) return;
        if (cfg.stdout) channel.emit("data", toBuf(cfg.stdout));
        if (cfg.stderr) channel.stderr.emit("data", toBuf(cfg.stderr));
        channel.emit("exit", cfg.exitCode ?? 0);
        channel.closed = true;
        channel.emit("close");
      };

      if (cfg.closeDelayMs && cfg.closeDelayMs > 0) {
        setTimeout(emit, cfg.closeDelayMs);
      } else {
        emit();
      }
      return this;
    }

    sftp(cb: (err: Error | undefined, sftp?: FakeSFTP) => void): this {
      mockState.sftpOpens += 1;
      if (mockState.sftpShouldFail) {
        cb(mockState.sftpShouldFail);
      } else {
        cb(undefined, new FakeSFTP());
      }
      return this;
    }

    end(): this {
      mockState.ended += 1;
      this.emit("close");
      return this;
    }
  }

  return { Client: FakeClient };
});

vi.mock("../../logger.ts", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Import AFTER vi.mock so the adapter binds to the mocked ssh2 + logger.
import {
  createSshSandboxBackend,
  sshSandboxConfigSchema,
  sshSandboxCredentialsSchema,
} from "./backend.ts";
import { logger } from "../../logger.ts";
import { plugin } from "./index.ts";
import { loadPlugins } from "../loader.ts";
import type { SandboxBackendContribution } from "@platypuschat/plugin-sdk";
import {
  makeFakePluginLogger,
  type FakePluginLogger,
} from "../../test-utils.ts";
import { MAX_READ_BYTES, MAX_SHELL_OUTPUT_BYTES } from "../../sandbox/index.ts";
import type { SandboxContext } from "../../sandbox/types.ts";

const ctx: SandboxContext = {
  orgId: "org-1",
  workspaceId: "ws-abc",
  userId: "user-1",
};

const CONFIG = {
  host: "ssh.example.com",
  port: 22,
  user: "platypus",
};
const CREDENTIALS = { privateKey: "PRIVATE_KEY_PEM" };

// Fake ed25519-shaped host-key blobs (base64). Real SSH key blobs base64-encode
// a length-prefixed algorithm name, so they begin with "AAAA" — the adapter's
// pin parser keys off that. The adapter compares the decoded bytes of the pin
// against the raw blob the (mock) server presents.
const HOST_KEY_B64 =
  "AAAAC3NzaC1lZDI1NTE5AAAAIExampleHostKeyBlobBytesForTestingAbc123";
const WRONG_HOST_KEY_B64 =
  "AAAAC3NzaC1lZDI1NTE5AAAAIWrongWrongWrongWrongWrongWrongWrong99999";

function resetMockState() {
  mockState = {
    connectConfigs: [],
    execCommands: [],
    execQueue: [],
    resolvedRoot: "/home/platypus/platypus-workspace",
    connectShouldFail: null,
    rootCreateFails: false,
    ended: 0,
    files: new Map(),
    dirs: new Set(),
    handles: new Map(),
    nextHandle: 1,
    sftpOpens: 0,
    sftpShouldFail: null,
    presentedHostKey: null,
  };
}

function queueExec(cfg: ExecConfig = {}) {
  mockState.execQueue.push(cfg);
}

// The `PluginLogger` seam core injects on the plugin's deploy-time block. The
// adapter logs through this rather than core's logger, so any suite asserting on
// a log line injects one and watches it — watching core's would pass vacuously.
let pluginLogger: FakePluginLogger;

const withPluginLogger = () => ({
  config: {},
  credentials: {},
  logger: pluginLogger,
});

beforeEach(() => {
  resetMockState();
  vi.clearAllMocks();
  pluginLogger = makeFakePluginLogger();
});

describe("sshSandboxConfigSchema / credentialsSchema", () => {
  it("defaults port to 22 and accepts optional rootDir/hostKey", () => {
    const parsed = sshSandboxConfigSchema.parse({
      host: "h",
      user: "u",
    });
    expect(parsed.port).toBe(22);
    expect(parsed.rootDir).toBeUndefined();
    expect(parsed.hostKey).toBeUndefined();
  });

  it("rejects unknown config fields (strict) and missing host/user", () => {
    expect(sshSandboxConfigSchema.safeParse({ user: "u" }).success).toBe(false);
    expect(sshSandboxConfigSchema.safeParse({ host: "h" }).success).toBe(false);
    expect(
      sshSandboxConfigSchema.safeParse({ host: "h", user: "u", extra: 1 })
        .success,
    ).toBe(false);
  });

  it("requires a privateKey and allows an optional passphrase", () => {
    expect(sshSandboxCredentialsSchema.safeParse({}).success).toBe(false);
    expect(
      sshSandboxCredentialsSchema.safeParse({ privateKey: "k" }).success,
    ).toBe(true);
    expect(
      sshSandboxCredentialsSchema.safeParse({
        privateKey: "k",
        passphrase: "p",
      }).success,
    ).toBe(true);
  });
});

describe("SshSandboxTransport — connect", () => {
  it("connects with public-key auth and creates the default workspace root", async () => {
    queueExec({ stdout: "hi", exitCode: 0 });
    const backend = createSshSandboxBackend(CONFIG, CREDENTIALS);
    await backend.shellExec(ctx, { command: "echo hi" });

    expect(mockState.connectConfigs).toHaveLength(1);
    const cc = mockState.connectConfigs[0];
    expect(cc.host).toBe("ssh.example.com");
    expect(cc.port).toBe(22);
    expect(cc.username).toBe("platypus");
    expect(cc.privateKey).toBe("PRIVATE_KEY_PEM");

    // First exec resolves $HOME and mkdir -p's the default root.
    expect(mockState.execCommands[0]).toContain(
      'ROOT="$HOME/platypus-workspace"',
    );
    expect(mockState.execCommands[0]).toContain('mkdir -p "$ROOT"');
    expect(mockState.execCommands[0]).toContain('printf %s "$ROOT"');
  });

  it("passes the passphrase through when provided", async () => {
    queueExec({ exitCode: 0 });
    const backend = createSshSandboxBackend(CONFIG, {
      privateKey: "K",
      passphrase: "secret",
    });
    await backend.shellExec(ctx, { command: "true" });
    expect(mockState.connectConfigs[0].passphrase).toBe("secret");
  });

  it("warns loudly about MITM when no hostKey is pinned", async () => {
    queueExec({ exitCode: 0 });
    const backend = createSshSandboxBackend(
      CONFIG,
      CREDENTIALS,
      withPluginLogger(),
    );
    await backend.shellExec(ctx, { command: "true" });
    expect(pluginLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ host: "ssh.example.com" }),
      expect.stringContaining("WITHOUT host-key verification"),
    );
  });

  it("uses a custom rootDir when configured", async () => {
    queueExec({ exitCode: 0 });
    const backend = createSshSandboxBackend(
      { ...CONFIG, rootDir: "/srv/agent" },
      CREDENTIALS,
    );
    await backend.shellExec(ctx, { command: "true" });
    expect(mockState.execCommands[0]).toContain("ROOT='/srv/agent'");
  });

  it("rejects when the SSH connection errors", async () => {
    mockState.connectShouldFail = new Error("auth failed");
    const backend = createSshSandboxBackend(CONFIG, CREDENTIALS);
    await expect(backend.shellExec(ctx, { command: "true" })).rejects.toThrow(
      /auth failed/,
    );
  });

  it("throws when the workspace root cannot be created", async () => {
    mockState.rootCreateFails = true;
    const backend = createSshSandboxBackend(CONFIG, CREDENTIALS);
    await expect(backend.shellExec(ctx, { command: "true" })).rejects.toThrow(
      /failed to create workspace root/,
    );
  });
});

describe("SshSandboxTransport — host-key verification", () => {
  it("connects when the pinned hostKey matches the presented host key", async () => {
    queueExec({ exitCode: 0 });
    mockState.presentedHostKey = Buffer.from(HOST_KEY_B64, "base64");
    const backend = createSshSandboxBackend(
      // A full `ssh-keyscan`-style line: the parser picks the base64 blob token.
      { ...CONFIG, hostKey: `ssh-ed25519 ${HOST_KEY_B64}` },
      CREDENTIALS,
      withPluginLogger(),
    );
    await backend.shellExec(ctx, { command: "true" });

    expect(mockState.connectConfigs).toHaveLength(1);
    expect(typeof mockState.connectConfigs[0].hostVerifier).toBe("function");
    // The root-resolution exec ran → the connection is live.
    expect(mockState.execCommands.length).toBeGreaterThan(0);
    // No MITM warning is emitted when a pin is enforced.
    expect(pluginLogger.warn).not.toHaveBeenCalled();
  });

  it("rejects the connection with a clear error when the pin mismatches", async () => {
    // A bare base64 blob (single token) is also accepted as a pin.
    mockState.presentedHostKey = Buffer.from(HOST_KEY_B64, "base64");
    const backend = createSshSandboxBackend(
      { ...CONFIG, hostKey: WRONG_HOST_KEY_B64 },
      CREDENTIALS,
    );
    await expect(backend.shellExec(ctx, { command: "true" })).rejects.toThrow(
      /host-key verification failed/,
    );
    // No tools run — connect aborts before the root-resolution exec.
    expect(mockState.execCommands).toHaveLength(0);
  });

  it("connects without a hostVerifier and warns exactly once when no hostKey is pinned", async () => {
    queueExec({ exitCode: 0 });
    const backend = createSshSandboxBackend(
      CONFIG,
      CREDENTIALS,
      withPluginLogger(),
    );
    await backend.shellExec(ctx, { command: "true" });

    expect(mockState.connectConfigs[0].hostVerifier).toBeUndefined();
    expect(pluginLogger.warn).toHaveBeenCalledTimes(1);
    expect(pluginLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ host: "ssh.example.com" }),
      expect.stringContaining("WITHOUT host-key verification"),
    );
  });

  it("throws a clear error when the pinned hostKey cannot be parsed", async () => {
    const backend = createSshSandboxBackend(
      { ...CONFIG, hostKey: "# not a key" },
      CREDENTIALS,
    );
    await expect(backend.shellExec(ctx, { command: "true" })).rejects.toThrow(
      /hostKey/,
    );
    // Never even attempted to connect.
    expect(mockState.connectConfigs).toHaveLength(0);
  });
});

describe("SshSandboxTransport — shellExec", () => {
  it("prefixes cd <rootDir> and returns stdout/stderr/exitCode/durationMs", async () => {
    queueExec({ stdout: "out", stderr: "err", exitCode: 3 });
    const backend = createSshSandboxBackend(CONFIG, CREDENTIALS);
    const res = await backend.shellExec(ctx, { command: "run" });

    // Core hands the transport an argv (`/bin/sh -c <command>`); a login shell
    // sits in between, so every element is single-quoted before being joined.
    const cmd = mockState.execCommands[1];
    expect(cmd).toBe(
      "cd '/home/platypus/platypus-workspace' && '/bin/sh' '-c' 'run'",
    );
    expect(res.stdout).toBe("out");
    expect(res.stderr).toBe("err");
    expect(res.exitCode).toBe(3);
    expect(res.truncated).toBe(false);
    expect(typeof res.durationMs).toBe("number");
  });

  it("resolves cwd relative to the rootDir", async () => {
    queueExec({ exitCode: 0 });
    const backend = createSshSandboxBackend(CONFIG, CREDENTIALS);
    await backend.shellExec(ctx, { command: "ls", cwd: "sub/dir" });
    expect(mockState.execCommands[1]).toBe(
      "cd '/home/platypus/platypus-workspace/sub/dir' && '/bin/sh' '-c' 'ls'",
    );
  });

  it("applies env via export statements (not the ssh2 env option)", async () => {
    queueExec({ exitCode: 0 });
    const backend = createSshSandboxBackend(CONFIG, CREDENTIALS);
    await backend.shellExec(ctx, {
      command: "printenv",
      env: { FOO: "bar", TOKEN: "a b'c" },
    });
    const cmd = mockState.execCommands[1];
    expect(cmd).toContain("export FOO='bar'; ");
    // Single quotes in the value are escaped with the '\'' idiom.
    expect(cmd).toContain("export TOKEN='a b'\\''c'; ");
    // env is applied inside the command string, never via a connect/env option.
    expect(mockState.connectConfigs[0].env).toBeUndefined();
  });

  it("drops env keys that are not valid POSIX identifiers", async () => {
    queueExec({ exitCode: 0 });
    const backend = createSshSandboxBackend(CONFIG, CREDENTIALS);
    await backend.shellExec(ctx, {
      command: "run",
      // A malformed key (model-supplied env is not schema-key-validated) must
      // never be interpolated raw into the shell string.
      env: { GOOD: "1", "bad;rm -rf": "x" },
    });
    const cmd = mockState.execCommands[1];
    expect(cmd).toContain("export GOOD='1'; ");
    expect(cmd).not.toContain("rm -rf");
  });

  it("stops buffering the ssh2 stream once the caller's stdout cap is reached", async () => {
    // The cap is enforced while the channel is streaming, not afterwards: the
    // fake emits more than the cap in one chunk and only the cap is retained.
    const huge = "a".repeat(MAX_SHELL_OUTPUT_BYTES + 5_000);
    queueExec({ stdout: huge, exitCode: 0 });
    const backend = createSshSandboxBackend(CONFIG, CREDENTIALS);
    const res = await backend.shellExec(ctx, { command: "yes" });
    expect(res.stdout.length).toBe(MAX_SHELL_OUTPUT_BYTES);
    expect(res.truncated).toBe(true);
  });

  it("returns exit code 124 when a command exceeds its timeout", async () => {
    // Channel closes after 200ms; timeout is 20ms, so the adapter closes first.
    queueExec({ closeDelayMs: 200, exitCode: 0 });
    const backend = createSshSandboxBackend(CONFIG, CREDENTIALS);
    const res = await backend.shellExec(ctx, {
      command: "sleep 5",
      timeoutMs: 20,
    });
    expect(res.exitCode).toBe(124);
  });
});

describe("SshSandboxTransport — connection lifecycle", () => {
  it("reuses a single connection across tool calls within a turn", async () => {
    queueExec({ exitCode: 0 });
    queueExec({ exitCode: 0 });
    const backend = createSshSandboxBackend(CONFIG, CREDENTIALS);
    await backend.shellExec(ctx, { command: "a" });
    await backend.shellExec(ctx, { command: "b" });

    // One connect, one root-resolution exec, then two command execs.
    expect(mockState.connectConfigs).toHaveLength(1);
    expect(mockState.execCommands).toHaveLength(3);
  });

  it("concurrent first-callers share one connect (inflight promise)", async () => {
    queueExec({ exitCode: 0 });
    queueExec({ exitCode: 0 });
    const backend = createSshSandboxBackend(CONFIG, CREDENTIALS);
    await Promise.all([
      backend.shellExec(ctx, { command: "a" }),
      backend.shellExec(ctx, { command: "b" }),
    ]);
    expect(mockState.connectConfigs).toHaveLength(1);
  });

  it("closes the connection via the idle reaper after inactivity", async () => {
    vi.useFakeTimers();
    try {
      queueExec({ exitCode: 0 });
      const backend = createSshSandboxBackend(CONFIG, CREDENTIALS);
      await backend.shellExec(ctx, { command: "true" });
      expect(mockState.ended).toBe(0);

      // Advance past the idle timeout — the reaper disconnects.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockState.ended).toBe(1);

      // A subsequent call reconnects.
      queueExec({ exitCode: 0 });
      await backend.shellExec(ctx, { command: "again" });
      expect(mockState.connectConfigs).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SshSandboxTransport — destroy() is a no-op", () => {
  it("disconnects without running any remote mutation command", async () => {
    queueExec({ exitCode: 0 });
    const backend = createSshSandboxBackend(CONFIG, CREDENTIALS);
    await backend.shellExec(ctx, { command: "true" });
    const execCountBefore = mockState.execCommands.length;

    await backend.destroy(ctx);

    // No extra exec issued (no rm / cleanup) — just a disconnect.
    expect(mockState.execCommands.length).toBe(execCountBefore);
    expect(mockState.ended).toBe(1);
  });

  it("is safe to call when never connected", async () => {
    const backend = createSshSandboxBackend(CONFIG, CREDENTIALS);
    await expect(backend.destroy(ctx)).resolves.toBeUndefined();
    expect(mockState.connectConfigs).toHaveLength(0);
    expect(mockState.ended).toBe(0);
  });
});

// The absolute workspace root the mock resolves at connect time (mockState.
// resolvedRoot). fs.* paths are relative to this.
const ROOT = "/home/platypus/platypus-workspace";
const abs = (rel: string) => `${ROOT}/${rel}`;

// Seed the in-memory SFTP filesystem with a file at a workspace-relative path.
function seedFile(rel: string, content: string | Buffer) {
  mockState.files.set(
    abs(rel),
    typeof content === "string" ? Buffer.from(content, "utf8") : content,
  );
}

describe("SshSandboxTransport — fs.write (SFTP)", () => {
  it("create mode fails cleanly when the target already exists", async () => {
    seedFile("exists.txt", "old");
    const backend = createSshSandboxBackend(CONFIG, CREDENTIALS);
    await expect(
      backend.fsWrite(ctx, {
        path: "exists.txt",
        content: "new",
        mode: "create",
      }),
    ).rejects.toThrow(/already exists/);
    // Untouched — the atomic `wx` open never opened it for writing.
    expect(mockState.files.get(abs("exists.txt"))?.toString("utf8")).toBe(
      "old",
    );
  });

  it("auto-creates parent directories (mkdir -p) before writing", async () => {
    const backend = createSshSandboxBackend(CONFIG, CREDENTIALS);
    await backend.fsWrite(ctx, {
      path: "a/b/c/deep.txt",
      content: "x",
      mode: "create",
    });
    expect(mockState.dirs.has(abs("a"))).toBe(true);
    expect(mockState.dirs.has(abs("a/b"))).toBe(true);
    expect(mockState.dirs.has(abs("a/b/c"))).toBe(true);
    expect(mockState.files.get(abs("a/b/c/deep.txt"))?.toString("utf8")).toBe(
      "x",
    );
  });

  it("writes paths literally over SFTP (no shell quoting/injection)", async () => {
    const backend = createSshSandboxBackend(CONFIG, CREDENTIALS);
    const weird = `foo";rm -rf /.txt`;
    await backend.fsWrite(ctx, {
      path: weird,
      content: "safe",
      mode: "create",
    });
    // The literal metachar path is a key in the store; no exec command ran it.
    expect(mockState.files.has(abs(weird))).toBe(true);
    expect(mockState.execCommands.every((c) => !c.includes("rm -rf"))).toBe(
      true,
    );
  });
});

describe("SshSandboxTransport — fs.read (SFTP)", () => {
  it("reads no more than the cap however large the file is", async () => {
    // The transport fstat()s first and asks for min(size, cap), so an oversized
    // file costs the cap and no more. What that means for `truncated` is core's
    // call, not this adapter's — see sandbox/posix.test.ts.
    seedFile("big.txt", "a".repeat(MAX_READ_BYTES + 5_000));
    const backend = createSshSandboxBackend(CONFIG, CREDENTIALS);
    const res = await backend.fsRead(ctx, { path: "big.txt" });
    expect(res.content.length).toBe(MAX_READ_BYTES);
  });

  it("reads a file smaller than the cap whole", async () => {
    // min(size, cap) must not over-request either: asking for `cap` bytes of a
    // short file is what a naive read would do, and SFTP would pad the buffer.
    seedFile("small.txt", "abc");
    const backend = createSshSandboxBackend(CONFIG, CREDENTIALS);
    const res = await backend.fsRead(ctx, { path: "small.txt" });
    expect(res.content).toBe("abc");
  });
});

describe("SshSandboxTransport — SFTP session lifecycle", () => {
  it("opens the SFTP subsystem once and reuses it across fs calls in a turn", async () => {
    const backend = createSshSandboxBackend(CONFIG, CREDENTIALS);
    await backend.fsWrite(ctx, { path: "a.txt", content: "1", mode: "create" });
    await backend.fsRead(ctx, { path: "a.txt" });
    await backend.fsEdit(ctx, {
      path: "a.txt",
      oldString: "1",
      newString: "2",
    });
    // One connect, one SFTP open, reused for all three fs calls.
    expect(mockState.connectConfigs).toHaveLength(1);
    expect(mockState.sftpOpens).toBe(1);
  });

  it("propagates an SFTP subsystem open failure", async () => {
    mockState.sftpShouldFail = new Error("sftp channel refused");
    const backend = createSshSandboxBackend(CONFIG, CREDENTIALS);
    await expect(backend.fsRead(ctx, { path: "a.txt" })).rejects.toThrow(
      /sftp channel refused/,
    );
  });
});

// The find command is the last exec (execCommands[0] is the connect-time root
// resolution). Grab it for command-shape assertions.
const lastFindCommand = () =>
  mockState.execCommands[mockState.execCommands.length - 1];

// find(1)'s own `\t`/`\n` escapes, as they appear inside the single-quoted
// -printf argument on the wire (the shell must pass them through untouched).
const PRINTF_ARG = String.raw`'-printf' '%y\t%s\t%P\n'`;

describe("SshSandboxTransport — fs.list (exec find)", () => {
  it("quotes every element of the find argv core handed it", async () => {
    queueExec({ stdout: "", exitCode: 0 });
    const backend = createSshSandboxBackend(CONFIG, CREDENTIALS);
    await backend.fsList(ctx, {});
    // Core passes cwd=rootDir, so the `cd` prefix precedes find as well; the
    // argv itself (find, its target, its flags) is core's — this only asserts
    // that none of it reaches the login shell unquoted.
    expect(lastFindCommand()).toBe(
      `cd '${ROOT}' && 'find' '${ROOT}' '-maxdepth' '1' '-mindepth' '1' ${PRINTF_ARG}`,
    );
  });

  it("single-quotes the list path so shell metacharacters cannot break out", async () => {
    queueExec({ stdout: "", exitCode: 0 });
    const backend = createSshSandboxBackend(CONFIG, CREDENTIALS);
    // A metachar-laden path (schema rejects absolute/`..`, but quote defensively).
    await backend.fsList(ctx, { path: `foo; rm -rf ~` });
    // The whole path is inside one single-quoted argument.
    expect(lastFindCommand()).toBe(
      `cd '${ROOT}' && 'find' '${ROOT}/foo; rm -rf ~' '-maxdepth' '1' '-mindepth' '1' ${PRINTF_ARG}`,
    );
  });

  it("escapes an embedded single quote in the path", async () => {
    queueExec({ stdout: "", exitCode: 0 });
    const backend = createSshSandboxBackend(CONFIG, CREDENTIALS);
    await backend.fsList(ctx, { path: `it's` });
    // classic '\'' escape idiom, matching shQuote.
    expect(lastFindCommand()).toContain(`'find' '${ROOT}/it'\\''s'`);
  });
});

describe("SshSandboxTransport — plugin-injected logger", () => {
  // ADR-0012's security-relevant line. Its level and exact wording are pinned
  // here as well as in the host-key suite above: this is a routing change, and a
  // warning an Operator relies on must survive it byte for byte.
  it("writes the unpinned-host-key warning to the injected logger, not core's", async () => {
    queueExec({ exitCode: 0 });

    const backend = createSshSandboxBackend(
      CONFIG,
      CREDENTIALS,
      withPluginLogger(),
    );
    await backend.shellExec(ctx, { command: "true" });

    expect(pluginLogger.warn).toHaveBeenCalledTimes(1);
    expect(pluginLogger.warn).toHaveBeenCalledWith(
      { host: "ssh.example.com", port: 22 },
      "SSH sandbox connecting WITHOUT host-key verification — session and injected env are exposed to a MITM. Set `hostKey` to pin the host.",
    );
    // The whole point: core's logger is no longer the adapter's channel.
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("degrades to silence when core injects no logger", async () => {
    // `PluginConfigContext.logger` is optional under the SDK's append-only
    // policy. Core always supplies it; a directly-constructed adapter does not,
    // and the connection must still be made rather than throwing.
    queueExec({ exitCode: 0 });

    const backend = createSshSandboxBackend(CONFIG, CREDENTIALS);
    await expect(
      backend.shellExec(ctx, { command: "true" }),
    ).resolves.toBeDefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("reaches the adapter through the manifest's create()", async () => {
    // The full contribution path core uses: the loader calls `create` with the
    // plugin block as its third argument, and the manifest must forward it.
    queueExec({ exitCode: 0 });

    const contribution = plugin.contributes.sandboxBackends![0];
    const backend = contribution.create(
      CONFIG,
      CREDENTIALS,
      withPluginLogger(),
    );
    await backend.shellExec(ctx, { command: "true" });

    expect(pluginLogger.warn).toHaveBeenCalledWith(
      { host: "ssh.example.com", port: 22 },
      expect.stringContaining("WITHOUT host-key verification"),
    );
  });

  it("carries the manifest name on the MITM warning when loaded by the real loader", async () => {
    // End to end through the path production takes — loader → deploy-time block
    // → `create` → transport. Every other test here supplies its own logger and
    // would pass even if the loader bound the wrong name, or none. This warning
    // is the one an Operator is most likely to alert on (ADR-0012), so what it
    // is tagged with is worth pinning against the real loader.
    queueExec({ exitCode: 0 });

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

    const captured: SandboxBackendContribution[] = [];
    await loadPlugins({
      pluginNames: ["@platypus/ssh"],
      registerSandbox: (c) => captured.push(c),
      baseLogger,
    });

    const backend = captured[0].create(CONFIG, CREDENTIALS);
    await backend.shellExec(ctx, { command: "true" });

    expect(lines).toContainEqual({
      bindings: { plugin: "@platypus/ssh", level: "warn" },
      fields: { host: "ssh.example.com", port: 22 },
      msg: "SSH sandbox connecting WITHOUT host-key verification — session and injected env are exposed to a MITM. Set `hostKey` to pin the host.",
    });
  });
});
