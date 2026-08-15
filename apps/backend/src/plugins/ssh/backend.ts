import {
  Client,
  type ClientChannel,
  type ConnectConfig,
  type OpenMode,
  type SFTPWrapper,
} from "ssh2";
import { z } from "zod";
import type {
  PluginConfigContext,
  PluginLogger,
} from "@platypuschat/plugin-sdk";
import {
  DEFAULT_SHELL_TIMEOUT_MS,
  MAX_SHELL_OUTPUT_BYTES,
} from "../../sandbox/index.ts";
import { createPosixSandbox } from "../../sandbox/posix.ts";
import {
  createCappedSink,
  SandboxPathExistsError,
  type SandboxExecOptions,
  type SandboxExecResult,
  type SandboxTransport,
} from "../../sandbox/transport.ts";
import type { SandboxBackend, SandboxContext } from "../../sandbox/types.ts";

// The SSH reference Sandbox adapter (ADR-0012). Attaches to a pre-existing,
// operator-owned host over SSH (public-key auth only) and supplies the
// transport core builds the fixed tool core on.
//
// Commands run over the `exec` channel and files over the SFTP subsystem — the
// faithful analogue of Docker's `putArchive` writes: literal paths, no
// shell-injection surface, native `wx`=create / `w`=overwrite. `exec` is the
// one place a shell is involved, because a login shell always is; every argv
// element and every interpolated value is single-quoted there, which is what
// lets core hand this transport an unescaped argv like any other.
//
// The adapter never provisions or destroys the machine.

const DEFAULT_SSH_PORT = 22;
// rootDir default (ADR-0012): resolved to `$HOME/platypus-workspace` on the host
// at connect time. SFTP does not expand `~`, so $HOME is resolved once per
// connection and the physical root is absolute.
const DEFAULT_ROOT_DIR_NAME = "platypus-workspace";

// Self-managed connection lifecycle (ADR-0012): a single connection is reused
// across all tool calls within a Chat turn and closed by this idle reaper after
// inactivity. The timer is `unref()`'d so it never keeps the process alive.
const IDLE_TIMEOUT_MS = 60_000;

// Per-Workspace Sandbox config/credentials (ADR-0001/0006). These remain
// per-Workspace settings — ADR-0013's deploy-time *plugin* config does not apply
// here. Every field except a hypothetical display name is admin-only (ADR-0006);
// the route enforces that gating, so no per-field logic is needed here.
export const sshSandboxConfigSchema = z
  .object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).default(DEFAULT_SSH_PORT),
    user: z.string().min(1),
    // Optional; defaults to `$HOME/platypus-workspace`, resolved on connect. A
    // relative value is resolved against the login `$HOME`; an absolute value is
    // used verbatim.
    rootDir: z.string().min(1).optional(),
    // Optional host-key pin (ADR-0012). When set, the presented host key is
    // strictly verified against it and a mismatch aborts the connection; when
    // absent, we connect with a loud MITM warning (the frictionless fallback).
    // Accepts `ssh-keyscan`/known_hosts output (`[host] <type> <base64>`) or a
    // bare base64 key blob — see parseHostKeyPin.
    hostKey: z.string().min(1).optional(),
  })
  .strict();

// Public-key auth only (ADR-0012). `privateKey` is a PEM/OpenSSH private key;
// `passphrase` decrypts it when it is encrypted. Both are server-side secrets,
// never returned to non-admins or the model.
export const sshSandboxCredentialsSchema = z
  .object({
    privateKey: z.string().min(1),
    passphrase: z.string().optional(),
  })
  .strict();

export type SshSandboxConfig = z.infer<typeof sshSandboxConfigSchema>;
export type SshSandboxCredentials = z.infer<typeof sshSandboxCredentialsSchema>;

// A live, ready connection plus the absolute workspace root resolved on it.
// `sftp` is opened lazily on the first fs.* call and reused for the rest of the
// turn (it rides the same connection; closing the client tears it down too).
type Connection = {
  client: Client;
  rootDir: string;
  sftp: SFTPWrapper | null;
};

// Single-quote a value for safe interpolation into a `/bin/sh` command line.
// Wraps in single quotes and escapes embedded single quotes with the classic
// `'\''` idiom. Used for the operator-supplied rootDir and for model-supplied
// cwd/env values so neither can break out into shell syntax.
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// A valid POSIX environment-variable name. `adminEnv`/`userEnv` are already held
// to this by the schema, but the model-supplied `input.env` keys are not — so we
// guard here before interpolating a key into the shell string. A key that isn't
// a valid identifier can't be a usable env var anyway (`export 1FOO=…` errors),
// so dropping it is both safe and correct.
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Build the `export KEY=val;` prefix for the merged env (ADR-0004). Applied via
// export statements rather than the ssh2 `env` option, since sshd's `AcceptEnv`
// rejects arbitrary variables by default (ADR-0012). Keys are guarded to POSIX
// identifiers (above) so they can't inject shell syntax; values are single-quoted.
function buildEnvPrefix(env: Record<string, string> | undefined): string {
  if (!env) return "";
  return Object.entries(env)
    .filter(([k]) => ENV_KEY_PATTERN.test(k))
    .map(([k, v]) => `export ${k}=${shQuote(v)}; `)
    .join("");
}

// ---------------------------------------------------------------------------
// Promisified SFTP primitives. ssh2's SFTP API is callback-based; these thin
// wrappers make the fs.* methods readable. `write()`/`read()` handle packet
// overflow internally (recursing on the remaining range), so one call transfers
// the whole requested span and fires its callback once.
// ---------------------------------------------------------------------------

function sftpStatExists(sftp: SFTPWrapper, path: string): Promise<boolean> {
  return new Promise((resolve) => {
    sftp.stat(path, (err) => resolve(!err));
  });
}

function sftpMkdir(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(path, (err) => (err ? reject(err) : resolve()));
  });
}

function sftpOpen(
  sftp: SFTPWrapper,
  path: string,
  flag: OpenMode,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.open(path, flag, (err, handle) =>
      err ? reject(err) : resolve(handle),
    );
  });
}

function sftpClose(sftp: SFTPWrapper, handle: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.close(handle, (err) => (err ? reject(err) : resolve()));
  });
}

function sftpFstatSize(sftp: SFTPWrapper, handle: Buffer): Promise<number> {
  return new Promise((resolve, reject) => {
    sftp.fstat(handle, (err, stats) =>
      err ? reject(err) : resolve(stats.size),
    );
  });
}

// Write the whole buffer at offset 0. ssh2's write splits oversized buffers into
// packets internally, so a single call suffices.
function sftpWriteAll(
  sftp: SFTPWrapper,
  handle: Buffer,
  buf: Buffer,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (buf.length === 0) {
      resolve();
      return;
    }
    sftp.write(handle, buf, 0, buf.length, 0, (err) =>
      err ? reject(err) : resolve(),
    );
  });
}

// Read up to `cap` bytes from an open handle. Loops defensively over short reads
// (a server may return fewer bytes than requested); stops at EOF (a zero-byte
// read) or once the cap is reached.
async function sftpReadCapped(
  sftp: SFTPWrapper,
  handle: Buffer,
  cap: number,
): Promise<Buffer> {
  const buf = Buffer.alloc(cap);
  let total = 0;
  while (total < cap) {
    const bytesRead = await new Promise<number>((resolve, reject) => {
      sftp.read(handle, buf, total, cap - total, total, (err, n) =>
        err ? reject(err) : resolve(n),
      );
    });
    if (bytesRead <= 0) break;
    total += bytesRead;
  }
  return buf.subarray(0, total);
}

// Parse an operator-supplied host-key pin to the raw public-key blob bytes that
// ssh2's `hostVerifier` presents (with no `hostHash` set, it receives the raw
// key Buffer). Accepts three shapes: a full `ssh-keyscan` / known_hosts line
// (`[host] <type> <base64> [comment]`), a `<type> <base64>` pair, or a bare
// base64 blob. Every SSH public-key blob base64-encodes a length-prefixed
// algorithm name, so the blob token always begins with `AAAA` — we pick that
// token when the input has several, else treat the sole token as the blob.
// Throws on input we cannot turn into a non-empty key so a misconfigured pin
// surfaces at connect time rather than silently failing every handshake.
function parseHostKeyPin(pin: string): Buffer {
  const firstLine = pin
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"));
  if (!firstLine) {
    throw new Error("SSH sandbox: `hostKey` is empty or comment-only");
  }
  const tokens = firstLine.split(/\s+/);
  const blob =
    tokens.find((t) => t.startsWith("AAAA")) ??
    (tokens.length === 1 ? tokens[0] : undefined);
  if (!blob) {
    throw new Error(
      "SSH sandbox: could not find a base64 host key in `hostKey` " +
        "(expected `ssh-keyscan` output or a base64 key blob)",
    );
  }
  const decoded = Buffer.from(blob, "base64");
  if (decoded.length === 0) {
    throw new Error("SSH sandbox: `hostKey` did not decode to a valid key");
  }
  return decoded;
}

/**
 * The SSH half of the Sandbox: ssh2 `exec` for commands, SFTP for files, and a
 * self-managed connection with an idle reaper (ADR-0012). The five model-facing
 * tools are built on top of this by {@link createPosixSandbox} — nothing here
 * parses find(1), counts lines, or decides what `truncated` means.
 */
export class SshSandboxTransport implements SandboxTransport {
  private config: SshSandboxConfig;
  private credentials: SshSandboxCredentials;
  // Single reused connection and its in-flight promise (mirrors the Docker
  // adapter's ensureContainer): concurrent first-callers share one connect.
  private connection: Connection | null;
  private inflight: Promise<Connection> | null;
  private idleTimer: NodeJS.Timeout | null;
  /**
   * The logger core bound to `@platypus/ssh` and injected on the plugin's
   * deploy-time block (ADR-0013) — see the Docker transport for why an in-tree
   * plugin consumes the third-party contract rather than importing core's
   * logger. Optional because {@link PluginConfigContext.logger} is, so the one
   * call site below is written `this.logger?.…`; the connection is still made
   * when it is absent, silently.
   */
  private logger?: PluginLogger;

  constructor(
    config: SshSandboxConfig,
    credentials: SshSandboxCredentials,
    logger?: PluginLogger,
  ) {
    this.config = config;
    this.credentials = credentials;
    this.connection = null;
    this.inflight = null;
    this.idleTimer = null;
    this.logger = logger;
  }

  // Lazy-connect on first use; reuse the single connection across all tool calls
  // in the turn. Concurrent callers before the connection is ready share the one
  // in-flight promise. Every call refreshes the idle reaper.
  private ensureConnection(): Promise<Connection> {
    if (this.connection) {
      this.touchIdleTimer();
      return Promise.resolve(this.connection);
    }
    if (this.inflight) return this.inflight;

    const p = this.connect()
      .then((conn) => {
        this.connection = conn;
        this.inflight = null;
        this.touchIdleTimer();
        return conn;
      })
      .catch((err) => {
        this.inflight = null;
        throw err;
      });
    this.inflight = p;
    return p;
  }

  // Open the SSH connection (public-key auth), then resolve $HOME and `mkdir -p`
  // the workspace root in a single exec, returning the absolute root.
  private async connect(): Promise<Connection> {
    const { host, port, user, hostKey } = this.config;
    const { privateKey, passphrase } = this.credentials;

    // Parse the pin up front so a malformed value fails loudly here rather than
    // silently rejecting every handshake. Absent → connect with a loud MITM
    // warning (the frictionless fallback for localhost/dev; ADR-0012).
    const expectedHostKey = hostKey ? parseHostKeyPin(hostKey) : null;
    if (!expectedHostKey) {
      // Public-key auth still prevents credential theft by an impostor host; the
      // residual risk is session/output exposure to a MITM. Pin `hostKey` on
      // internet-facing hosts.
      this.logger?.warn(
        { host, port },
        "SSH sandbox connecting WITHOUT host-key verification — session and injected env are exposed to a MITM. Set `hostKey` to pin the host.",
      );
    }

    const client = new Client();
    const connectConfig: ConnectConfig = {
      host,
      port: port ?? DEFAULT_SSH_PORT,
      username: user,
      privateKey,
      ...(passphrase ? { passphrase } : {}),
    };

    // Strict host-key pinning (ADR-0012). ssh2 calls this synchronous verifier
    // with the presented raw key blob during the handshake; returning false
    // aborts with a handshake `error`. `hostKeyMismatch` lets onError turn that
    // opaque failure into a clear, actionable message.
    let hostKeyMismatch = false;
    if (expectedHostKey) {
      const expected = expectedHostKey;
      connectConfig.hostVerifier = (presented: Buffer): boolean => {
        const match = presented.equals(expected);
        if (!match) hostKeyMismatch = true;
        return match;
      };
    }

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        client.removeListener("ready", onReady);
        if (hostKeyMismatch) {
          reject(
            new Error(
              `SSH sandbox: host-key verification failed for ${host}:${port ?? DEFAULT_SSH_PORT} — the presented host key does not match the pinned \`hostKey\`. Refusing to connect.`,
              { cause: err },
            ),
          );
          return;
        }
        reject(err);
      };
      const onReady = () => {
        client.removeListener("error", onError);
        resolve();
      };
      client.once("ready", onReady);
      client.once("error", onError);
      client.connect(connectConfig);
    });

    // Resolve $HOME and create the root in one round-trip. A relative rootDir is
    // resolved against $HOME; an absolute one is used verbatim. The command
    // prints the resolved absolute path on stdout.
    const rootExpr = this.config.rootDir
      ? shQuote(this.config.rootDir)
      : `"$HOME/${DEFAULT_ROOT_DIR_NAME}"`;
    const resolveCmd =
      `ROOT=${rootExpr}; ` +
      `case "$ROOT" in /*) ;; *) ROOT="$HOME/$ROOT" ;; esac; ` +
      `mkdir -p "$ROOT" && printf %s "$ROOT"`;

    const res = await this.runExec(
      client,
      resolveCmd,
      DEFAULT_SHELL_TIMEOUT_MS,
    );
    if (res.exitCode !== 0) {
      const detail = res.stderr.toString("utf8").trim() || "unknown error";
      try {
        client.end();
      } catch {
        // ignore
      }
      throw new Error(
        `SSH sandbox: failed to create workspace root on ${host}: ${detail}`,
      );
    }
    const rootDir = res.stdout.toString("utf8").trim();

    return { client, rootDir, sftp: null };
  }

  // (Re)arm the idle reaper. Closes the connection after IDLE_TIMEOUT_MS of
  // inactivity. `unref()` so a pending timer never keeps the process alive.
  private touchIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.closeConnection();
    }, IDLE_TIMEOUT_MS);
    this.idleTimer.unref?.();
  }

  // Close the connection (if any) and cancel the idle reaper. Idempotent.
  private closeConnection(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const conn = this.connection;
    this.connection = null;
    if (conn) {
      try {
        conn.client.end();
      } catch {
        // best-effort — the connection may already be gone
      }
    }
  }

  // Run a single command over `exec`, capping each stream independently and
  // enforcing a timeout. On timeout the channel is closed and exit code 124 is
  // reported (a remote command may keep running as an orphan — the host is not
  // ours to reap; ADR-0012).
  private runExec(
    client: Client,
    command: string,
    timeoutMs: number,
    stdoutCap: number = MAX_SHELL_OUTPUT_BYTES,
    stderrCap: number = MAX_SHELL_OUTPUT_BYTES,
  ): Promise<SandboxExecResult> {
    return new Promise<SandboxExecResult>((resolve, reject) => {
      const started = Date.now();
      client.exec(command, (err: Error | undefined, stream: ClientChannel) => {
        if (err) {
          reject(err);
          return;
        }

        const stdoutSink = createCappedSink(stdoutCap);
        const stderrSink = createCappedSink(stderrCap);
        let exitCode = 0;
        let timedOut = false;
        let settled = false;

        const timer = setTimeout(() => {
          timedOut = true;
          try {
            stream.close();
          } catch {
            // ignore — resolve on the close event regardless
          }
        }, timeoutMs);
        timer.unref?.();

        stream.on("data", (chunk: Buffer) => stdoutSink.push(chunk));
        stream.stderr.on("data", (chunk: Buffer) => stderrSink.push(chunk));
        // The exit code arrives on `exit`; `close` fires afterwards and is when
        // we settle. A signal-killed process reports a null code.
        stream.on("exit", (code: number | null) => {
          if (typeof code === "number") exitCode = code;
        });
        stream.on("close", () => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          resolve({
            stdout: stdoutSink.collect(),
            stderr: stderrSink.collect(),
            exitCode: timedOut ? 124 : exitCode,
            durationMs: Date.now() - started,
          });
        });
        stream.on("error", (streamErr: Error) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          reject(streamErr);
        });
      });
    });
  }

  // The workspace root, resolved once per connection against the host's `$HOME`
  // and created if missing. Also the lazy-connect hook: core calls this first in
  // every tool, so the connection opens on first use and is reused for the turn.
  async rootDir(_ctx: SandboxContext): Promise<string> {
    const conn = await this.ensureConnection();
    return conn.rootDir;
  }

  // A login shell always sits between us and the process, so every argv element
  // is single-quoted before being joined — that shell must not get a say in what
  // the words are. `cwd` becomes a `cd` prefix (there is no native working
  // directory over SSH) and the env goes in as `export` statements rather than
  // ssh2's `env` option, which sshd's `AcceptEnv` rejects by default (ADR-0012).
  async exec(
    _ctx: SandboxContext,
    argv: string[],
    opts: SandboxExecOptions,
  ): Promise<SandboxExecResult> {
    const conn = await this.ensureConnection();
    const cdPrefix = opts.cwd ? `cd ${shQuote(opts.cwd)} && ` : "";
    const command = `${cdPrefix}${buildEnvPrefix(opts.env)}${argv
      .map(shQuote)
      .join(" ")}`;

    const res = await this.runExec(
      conn.client,
      command,
      opts.timeoutMs,
      opts.stdoutCap,
      opts.stderrCap,
    );
    this.touchIdleTimer();
    return res;
  }

  // Read over SFTP: literal paths, no shell, no injection surface. The file is
  // sized first so only `min(size, cap)` is ever requested — but the size stops
  // there. Whether a capped read counts as truncated is core's single rule, not
  // this adapter's to answer better than the Docker one can.
  async readFile(
    _ctx: SandboxContext,
    absPath: string,
    cap: number,
  ): Promise<Buffer> {
    const conn = await this.ensureConnection();
    const sftp = await this.getSftp(conn);

    const handle = await sftpOpen(sftp, absPath, "r");
    try {
      const size = await sftpFstatSize(sftp, handle);
      return await sftpReadCapped(sftp, handle, Math.min(size, cap));
    } finally {
      await sftpClose(sftp, handle);
      this.touchIdleTimer();
    }
  }

  // Write over SFTP. `wx` fails atomically when the path is taken — a native
  // create with no racy stat/open window — and `w` truncates-or-creates.
  async writeFile(
    _ctx: SandboxContext,
    absPath: string,
    bytes: Buffer,
    mode: "create" | "overwrite",
  ): Promise<void> {
    const conn = await this.ensureConnection();
    const sftp = await this.getSftp(conn);

    await this.ensureParentDirs(sftp, conn.rootDir, absPath);

    let handle: Buffer;
    try {
      handle = await sftpOpen(sftp, absPath, mode === "create" ? "wx" : "w");
    } catch (cause) {
      // `wx` fails for more than just a collision (permissions, a missing
      // parent), so confirm which it was rather than reporting them alike.
      if (mode === "create" && (await sftpStatExists(sftp, absPath))) {
        throw new SandboxPathExistsError(absPath, { cause });
      }
      throw cause;
    }

    try {
      await sftpWriteAll(sftp, handle, bytes);
    } finally {
      await sftpClose(sftp, handle);
      this.touchIdleTimer();
    }
  }

  // Open the SFTP subsystem lazily and reuse it for the rest of the turn. It
  // rides the single reused connection, so closing the client (idle reaper /
  // destroy) tears it down too.
  private getSftp(conn: Connection): Promise<SFTPWrapper> {
    if (conn.sftp) return Promise.resolve(conn.sftp);
    return new Promise<SFTPWrapper>((resolve, reject) => {
      conn.client.sftp((err, sftp) => {
        if (err) {
          reject(err);
          return;
        }
        conn.sftp = sftp;
        resolve(sftp);
      });
    });
  }

  // `mkdir -p` the parent directories of a file over SFTP, which has no
  // recursive mkdir. Each segment is stat-probed and created only if absent.
  // The walk starts at the workspace root and never climbs above it: everything
  // above is the host's, not ours to create. Literal paths throughout, no shell.
  private async ensureParentDirs(
    sftp: SFTPWrapper,
    rootDir: string,
    absPath: string,
  ): Promise<void> {
    const idx = absPath.lastIndexOf("/");
    if (idx === -1) return;
    const parent = absPath.slice(0, idx);
    // The root itself always exists — it was created at connect time.
    if (!parent.startsWith(`${rootDir}/`)) return;

    const segments = parent
      .slice(rootDir.length + 1)
      .split("/")
      .filter((s) => s.length > 0);
    let dir = rootDir;
    for (const seg of segments) {
      dir = `${dir}/${seg}`;
      if (!(await sftpStatExists(sftp, dir))) {
        await sftpMkdir(sftp, dir);
      }
    }
  }

  // destroy() is a no-op beyond disconnecting (ADR-0012): the host is not
  // Platypus-owned, so we never mutate its filesystem. Just tear down our
  // connection so no socket or idle timer leaks.
  destroy(_ctx: SandboxContext): Promise<void> {
    this.closeConnection();
    return Promise.resolve();
  }
}

/**
 * The SSH Sandbox backend: this plugin's transport under core's fixed five-tool
 * core. What the model sees comes from {@link createPosixSandbox}, so this
 * adapter cannot drift from the Docker one on anything but the transport.
 */
export const createSshSandboxBackend = (
  config: SshSandboxConfig,
  credentials: SshSandboxCredentials,
  plugin?: PluginConfigContext,
): SandboxBackend =>
  createPosixSandbox(
    new SshSandboxTransport(config, credentials, plugin?.logger),
  );
