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
      } else {
        this.emit("ready");
      }
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
  SshSandboxBackend,
  sshSandboxConfigSchema,
  sshSandboxCredentialsSchema,
} from "./backend.ts";
import { logger } from "../../logger.ts";
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
  };
}

function queueExec(cfg: ExecConfig = {}) {
  mockState.execQueue.push(cfg);
}

beforeEach(() => {
  resetMockState();
  vi.clearAllMocks();
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

describe("SshSandboxBackend — connect", () => {
  it("connects with public-key auth and creates the default workspace root", async () => {
    queueExec({ stdout: "hi", exitCode: 0 });
    const backend = new SshSandboxBackend(CONFIG, CREDENTIALS);
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
    const backend = new SshSandboxBackend(CONFIG, {
      privateKey: "K",
      passphrase: "secret",
    });
    await backend.shellExec(ctx, { command: "true" });
    expect(mockState.connectConfigs[0].passphrase).toBe("secret");
  });

  it("warns loudly about MITM when no hostKey is pinned", async () => {
    queueExec({ exitCode: 0 });
    const backend = new SshSandboxBackend(CONFIG, CREDENTIALS);
    await backend.shellExec(ctx, { command: "true" });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ host: "ssh.example.com" }),
      expect.stringContaining("WITHOUT host-key verification"),
    );
  });

  it("uses a custom rootDir when configured", async () => {
    queueExec({ exitCode: 0 });
    const backend = new SshSandboxBackend(
      { ...CONFIG, rootDir: "/srv/agent" },
      CREDENTIALS,
    );
    await backend.shellExec(ctx, { command: "true" });
    expect(mockState.execCommands[0]).toContain("ROOT='/srv/agent'");
  });

  it("rejects when the SSH connection errors", async () => {
    mockState.connectShouldFail = new Error("auth failed");
    const backend = new SshSandboxBackend(CONFIG, CREDENTIALS);
    await expect(backend.shellExec(ctx, { command: "true" })).rejects.toThrow(
      /auth failed/,
    );
  });

  it("throws when the workspace root cannot be created", async () => {
    mockState.rootCreateFails = true;
    const backend = new SshSandboxBackend(CONFIG, CREDENTIALS);
    await expect(backend.shellExec(ctx, { command: "true" })).rejects.toThrow(
      /failed to create workspace root/,
    );
  });
});

describe("SshSandboxBackend — shellExec", () => {
  it("prefixes cd <rootDir> and returns stdout/stderr/exitCode/durationMs", async () => {
    queueExec({ stdout: "out", stderr: "err", exitCode: 3 });
    const backend = new SshSandboxBackend(CONFIG, CREDENTIALS);
    const res = await backend.shellExec(ctx, { command: "run" });

    const cmd = mockState.execCommands[1];
    expect(cmd).toBe("cd '/home/platypus/platypus-workspace' && run");
    expect(res.stdout).toBe("out");
    expect(res.stderr).toBe("err");
    expect(res.exitCode).toBe(3);
    expect(res.truncated).toBe(false);
    expect(typeof res.durationMs).toBe("number");
  });

  it("resolves cwd relative to the rootDir", async () => {
    queueExec({ exitCode: 0 });
    const backend = new SshSandboxBackend(CONFIG, CREDENTIALS);
    await backend.shellExec(ctx, { command: "ls", cwd: "sub/dir" });
    expect(mockState.execCommands[1]).toBe(
      "cd '/home/platypus/platypus-workspace/sub/dir' && ls",
    );
  });

  it("applies env via export statements (not the ssh2 env option)", async () => {
    queueExec({ exitCode: 0 });
    const backend = new SshSandboxBackend(CONFIG, CREDENTIALS);
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
    const backend = new SshSandboxBackend(CONFIG, CREDENTIALS);
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

  it("caps stdout at MAX_SHELL_OUTPUT_BYTES and flags truncated", async () => {
    const huge = "a".repeat(MAX_SHELL_OUTPUT_BYTES + 5_000);
    queueExec({ stdout: huge, exitCode: 0 });
    const backend = new SshSandboxBackend(CONFIG, CREDENTIALS);
    const res = await backend.shellExec(ctx, { command: "yes" });
    expect(res.stdout.length).toBe(MAX_SHELL_OUTPUT_BYTES);
    expect(res.truncated).toBe(true);
  });

  it("returns exit code 124 when a command exceeds its timeout", async () => {
    // Channel closes after 200ms; timeout is 20ms, so the adapter closes first.
    queueExec({ closeDelayMs: 200, exitCode: 0 });
    const backend = new SshSandboxBackend(CONFIG, CREDENTIALS);
    const res = await backend.shellExec(ctx, {
      command: "sleep 5",
      timeoutMs: 20,
    });
    expect(res.exitCode).toBe(124);
  });
});

describe("SshSandboxBackend — connection lifecycle", () => {
  it("reuses a single connection across tool calls within a turn", async () => {
    queueExec({ exitCode: 0 });
    queueExec({ exitCode: 0 });
    const backend = new SshSandboxBackend(CONFIG, CREDENTIALS);
    await backend.shellExec(ctx, { command: "a" });
    await backend.shellExec(ctx, { command: "b" });

    // One connect, one root-resolution exec, then two command execs.
    expect(mockState.connectConfigs).toHaveLength(1);
    expect(mockState.execCommands).toHaveLength(3);
  });

  it("concurrent first-callers share one connect (inflight promise)", async () => {
    queueExec({ exitCode: 0 });
    queueExec({ exitCode: 0 });
    const backend = new SshSandboxBackend(CONFIG, CREDENTIALS);
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
      const backend = new SshSandboxBackend(CONFIG, CREDENTIALS);
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

describe("SshSandboxBackend — destroy() is a no-op", () => {
  it("disconnects without running any remote mutation command", async () => {
    queueExec({ exitCode: 0 });
    const backend = new SshSandboxBackend(CONFIG, CREDENTIALS);
    await backend.shellExec(ctx, { command: "true" });
    const execCountBefore = mockState.execCommands.length;

    await backend.destroy(ctx);

    // No extra exec issued (no rm / cleanup) — just a disconnect.
    expect(mockState.execCommands.length).toBe(execCountBefore);
    expect(mockState.ended).toBe(1);
  });

  it("is safe to call when never connected", async () => {
    const backend = new SshSandboxBackend(CONFIG, CREDENTIALS);
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

describe("SshSandboxBackend — fs.write (SFTP)", () => {
  it("create mode writes a new file and returns bytesWritten", async () => {
    const backend = new SshSandboxBackend(CONFIG, CREDENTIALS);
    const res = await backend.fsWrite(ctx, {
      path: "notes.txt",
      content: "hello",
      mode: "create",
    });
    expect(res.bytesWritten).toBe(5);
    expect(mockState.files.get(abs("notes.txt"))?.toString("utf8")).toBe(
      "hello",
    );
  });

  it("create mode fails cleanly when the target already exists", async () => {
    seedFile("exists.txt", "old");
    const backend = new SshSandboxBackend(CONFIG, CREDENTIALS);
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

  it("overwrite mode replaces an existing file", async () => {
    seedFile("f.txt", "original content here");
    const backend = new SshSandboxBackend(CONFIG, CREDENTIALS);
    const res = await backend.fsWrite(ctx, {
      path: "f.txt",
      content: "new",
      mode: "overwrite",
    });
    expect(res.bytesWritten).toBe(3);
    expect(mockState.files.get(abs("f.txt"))?.toString("utf8")).toBe("new");
  });

  it("auto-creates parent directories (mkdir -p) before writing", async () => {
    const backend = new SshSandboxBackend(CONFIG, CREDENTIALS);
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
    const backend = new SshSandboxBackend(CONFIG, CREDENTIALS);
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

  it("writes zero-length content", async () => {
    const backend = new SshSandboxBackend(CONFIG, CREDENTIALS);
    const res = await backend.fsWrite(ctx, {
      path: "empty.txt",
      content: "",
      mode: "create",
    });
    expect(res.bytesWritten).toBe(0);
    expect(mockState.files.get(abs("empty.txt"))?.length).toBe(0);
  });
});

describe("SshSandboxBackend — fs.read (SFTP)", () => {
  it("reads content with correct lineCount and truncated=false", async () => {
    seedFile("f.txt", "line1\nline2\nline3\n");
    const backend = new SshSandboxBackend(CONFIG, CREDENTIALS);
    const res = await backend.fsRead(ctx, { path: "f.txt" });
    expect(res.content).toBe("line1\nline2\nline3\n");
    expect(res.lineCount).toBe(3);
    expect(res.truncated).toBe(false);
  });

  it("counts a trailing partial line", async () => {
    seedFile("f.txt", "a\nb\nc");
    const backend = new SshSandboxBackend(CONFIG, CREDENTIALS);
    const res = await backend.fsRead(ctx, { path: "f.txt" });
    expect(res.lineCount).toBe(3);
  });

  it("an empty file reads as zero lines", async () => {
    seedFile("empty.txt", "");
    const backend = new SshSandboxBackend(CONFIG, CREDENTIALS);
    const res = await backend.fsRead(ctx, { path: "empty.txt" });
    expect(res.content).toBe("");
    expect(res.lineCount).toBe(0);
    expect(res.truncated).toBe(false);
  });

  it("caps at MAX_READ_BYTES and flags truncated", async () => {
    seedFile("big.txt", "a".repeat(MAX_READ_BYTES + 5_000));
    const backend = new SshSandboxBackend(CONFIG, CREDENTIALS);
    const res = await backend.fsRead(ctx, { path: "big.txt" });
    expect(res.content.length).toBe(MAX_READ_BYTES);
    expect(res.truncated).toBe(true);
  });

  it("rejects a non-UTF-8 file with a clear error", async () => {
    // 0xff is never valid in UTF-8.
    seedFile("bin.dat", Buffer.from([0x66, 0x6f, 0xff, 0x6f]));
    const backend = new SshSandboxBackend(CONFIG, CREDENTIALS);
    await expect(backend.fsRead(ctx, { path: "bin.dat" })).rejects.toThrow(
      /not valid UTF-8/,
    );
  });

  it("honours lineRange, slicing the requested window", async () => {
    seedFile("f.txt", "one\ntwo\nthree\nfour\nfive\n");
    const backend = new SshSandboxBackend(CONFIG, CREDENTIALS);
    const res = await backend.fsRead(ctx, {
      path: "f.txt",
      lineRange: [2, 4],
    });
    expect(res.content).toBe("two\nthree\nfour\n");
    expect(res.lineCount).toBe(3);
  });
});

describe("SshSandboxBackend — fs.edit (SFTP)", () => {
  it("replaces exactly one occurrence and writes it back", async () => {
    seedFile("f.txt", "the quick brown fox");
    const backend = new SshSandboxBackend(CONFIG, CREDENTIALS);
    const res = await backend.fsEdit(ctx, {
      path: "f.txt",
      oldString: "quick",
      newString: "slow",
    });
    expect(res).toEqual({ replacements: 1 });
    expect(mockState.files.get(abs("f.txt"))?.toString("utf8")).toBe(
      "the slow brown fox",
    );
  });

  it("throws when oldString is absent", async () => {
    seedFile("f.txt", "nothing to see here");
    const backend = new SshSandboxBackend(CONFIG, CREDENTIALS);
    await expect(
      backend.fsEdit(ctx, {
        path: "f.txt",
        oldString: "missing",
        newString: "x",
      }),
    ).rejects.toThrow(/oldString not found/);
  });

  it("throws when oldString is not unique", async () => {
    seedFile("f.txt", "abc abc");
    const backend = new SshSandboxBackend(CONFIG, CREDENTIALS);
    await expect(
      backend.fsEdit(ctx, {
        path: "f.txt",
        oldString: "abc",
        newString: "x",
      }),
    ).rejects.toThrow(/not unique/);
    // Unchanged on failure.
    expect(mockState.files.get(abs("f.txt"))?.toString("utf8")).toBe("abc abc");
  });

  it("rejects a non-UTF-8 file", async () => {
    seedFile("bin.dat", Buffer.from([0xff, 0xfe]));
    const backend = new SshSandboxBackend(CONFIG, CREDENTIALS);
    await expect(
      backend.fsEdit(ctx, { path: "bin.dat", oldString: "a", newString: "b" }),
    ).rejects.toThrow(/not valid UTF-8/);
  });
});

describe("SshSandboxBackend — SFTP session lifecycle", () => {
  it("opens the SFTP subsystem once and reuses it across fs calls in a turn", async () => {
    const backend = new SshSandboxBackend(CONFIG, CREDENTIALS);
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
    const backend = new SshSandboxBackend(CONFIG, CREDENTIALS);
    await expect(backend.fsRead(ctx, { path: "a.txt" })).rejects.toThrow(
      /sftp channel refused/,
    );
  });
});

describe("SshSandboxBackend — fs.list still deferred", () => {
  it("fsList throws not-implemented", async () => {
    const backend = new SshSandboxBackend(CONFIG, CREDENTIALS);
    await expect(backend.fsList(ctx, {})).rejects.toThrow(/not yet supported/);
  });
});
