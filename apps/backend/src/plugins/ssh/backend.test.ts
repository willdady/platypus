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
import { MAX_SHELL_OUTPUT_BYTES } from "../../sandbox/index.ts";
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

describe("SshSandboxBackend — fs.* deferred to follow-up slices", () => {
  const backend = new SshSandboxBackend(CONFIG, CREDENTIALS);

  it("fsRead throws not-implemented", async () => {
    await expect(backend.fsRead(ctx, { path: "a" })).rejects.toThrow(
      /not yet supported/,
    );
  });
  it("fsWrite throws not-implemented", async () => {
    await expect(
      backend.fsWrite(ctx, { path: "a", content: "x", mode: "overwrite" }),
    ).rejects.toThrow(/not yet supported/);
  });
  it("fsEdit throws not-implemented", async () => {
    await expect(
      backend.fsEdit(ctx, { path: "a", oldString: "x", newString: "y" }),
    ).rejects.toThrow(/not yet supported/);
  });
  it("fsList throws not-implemented", async () => {
    await expect(backend.fsList(ctx, {})).rejects.toThrow(/not yet supported/);
  });
});
