import {
  Client,
  type ClientChannel,
  type ConnectConfig,
  type OpenMode,
  type SFTPWrapper,
} from "ssh2";
import { z } from "zod";
import { logger } from "../../logger.ts";
import {
  DEFAULT_SHELL_TIMEOUT_MS,
  MAX_READ_BYTES,
  MAX_SHELL_OUTPUT_BYTES,
  MAX_SHELL_TIMEOUT_MS,
} from "../../sandbox/index.ts";
import type {
  FsEditInput,
  FsEditOutput,
  FsListInput,
  FsListOutput,
  FsReadInput,
  FsReadOutput,
  FsWriteInput,
  FsWriteOutput,
  SandboxBackend,
  SandboxContext,
  ShellExecInput,
  ShellExecOutput,
} from "../../sandbox/types.ts";

// The SSH reference Sandbox adapter (ADR-0012). Attaches to a pre-existing,
// operator-owned host over SSH (public-key auth only) and runs the fixed tool
// core against it. `shell.exec` runs over the `exec` channel; `fs.read`,
// `fs.write`, and `fs.edit` run over the SFTP subsystem (the faithful analogue
// of Docker's `putArchive` writes — literal paths, no shell-injection surface,
// native `wx`=create / `w`=overwrite). `fs.list` lands in a follow-up slice.
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
    // Accepted now for forward-compatibility; strict host-key verification is a
    // follow-up slice (ADR-0012). This slice connects with a loud MITM warning
    // when it is absent — the shipped fallback.
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

type ExecResult = {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
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

// A method not carried by this slice. `fs.list` lands in a follow-up slice
// (ADR-0012: `find -printf`); until then it fails loudly rather than silently
// misbehaving. The Sandbox tool set still exposes all five tools (there is no
// per-backend tool filtering), so a model that calls it gets this as its result.
function notImplemented(tool: string): Promise<never> {
  return Promise.reject(
    new Error(
      `${tool} is not yet supported by the SSH sandbox backend (follow-up slice).`,
    ),
  );
}

// Resolve a workspace-root-relative path to an absolute path on the host. The
// schema already enforces the path is relative; SFTP takes the result literally,
// so there is no shell quoting and no injection surface (ADR-0012).
function absPath(rootDir: string, relative: string): string {
  return `${rootDir}/${relative.replace(/^\/+/, "")}`;
}

// Count lines the same way the Docker adapter does: newline count, less one for a
// trailing newline. Empty content is zero lines.
function countLines(content: string): number {
  if (content.length === 0) return 0;
  let lineCount = content.split("\n").length;
  if (content.endsWith("\n")) lineCount -= 1;
  return lineCount;
}

// Decode a Buffer as strict UTF-8, rejecting non-UTF-8 bytes (matching the
// Docker adapter, which decodes with `new TextDecoder("utf-8", { fatal: true })`).
function decodeUtf8Strict(buf: Buffer, tool: string, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw new Error(`${tool}: file is not valid UTF-8 (${path})`);
  }
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

export class SshSandboxBackend implements SandboxBackend {
  private config: SshSandboxConfig;
  private credentials: SshSandboxCredentials;
  // Single reused connection and its in-flight promise (mirrors the Docker
  // adapter's ensureContainer): concurrent first-callers share one connect.
  private connection: Connection | null;
  private inflight: Promise<Connection> | null;
  private idleTimer: NodeJS.Timeout | null;

  constructor(config: SshSandboxConfig, credentials: SshSandboxCredentials) {
    this.config = config;
    this.credentials = credentials;
    this.connection = null;
    this.inflight = null;
    this.idleTimer = null;
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

    if (!hostKey) {
      // Shipped fallback for this slice (ADR-0012): connect without host-key
      // verification and warn loudly. Public-key auth still prevents credential
      // theft by an impostor host; the residual risk is session/output exposure
      // to a MITM. Pin `hostKey` on internet-facing hosts.
      logger.warn(
        { host, port },
        "SSH sandbox connecting WITHOUT host-key verification — session and injected env are exposed to a MITM. Set `hostKey` to pin the host.",
      );
    } else {
      // hostKey is accepted but strict verification is not wired yet — a
      // follow-up slice. Be explicit so an operator who pinned a key is not
      // misled into thinking it is enforced.
      logger.warn(
        { host, port },
        "SSH sandbox `hostKey` is set but strict verification is not yet enforced (follow-up slice); connecting without pinning.",
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

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        client.removeListener("ready", onReady);
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

  // Run a single command over `exec`, capping stdout/stderr at
  // MAX_SHELL_OUTPUT_BYTES and enforcing a timeout. On timeout the channel is
  // closed and exit code 124 is reported (a remote command may keep running as
  // an orphan — the host is not ours to reap; ADR-0012).
  private runExec(
    client: Client,
    command: string,
    timeoutMs: number,
  ): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve, reject) => {
      const started = Date.now();
      client.exec(command, (err: Error | undefined, stream: ClientChannel) => {
        if (err) {
          reject(err);
          return;
        }

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
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

        const capture = (
          chunk: Buffer,
          chunks: Buffer[],
          bytes: number,
        ): number => {
          if (bytes >= MAX_SHELL_OUTPUT_BYTES) return bytes;
          const room = MAX_SHELL_OUTPUT_BYTES - bytes;
          const take = chunk.length <= room ? chunk : chunk.subarray(0, room);
          chunks.push(take);
          return bytes + take.length;
        };

        stream.on("data", (chunk: Buffer) => {
          stdoutBytes = capture(chunk, stdoutChunks, stdoutBytes);
        });
        stream.stderr.on("data", (chunk: Buffer) => {
          stderrBytes = capture(chunk, stderrChunks, stderrBytes);
        });
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
            stdout: Buffer.concat(stdoutChunks),
            stderr: Buffer.concat(stderrChunks),
            exitCode: timedOut ? 124 : exitCode,
            durationMs: Date.now() - started,
            timedOut,
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

  async shellExec(
    _ctx: SandboxContext,
    input: ShellExecInput,
  ): Promise<ShellExecOutput> {
    const conn = await this.ensureConnection();
    const timeoutMs = Math.min(
      input.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS,
      MAX_SHELL_TIMEOUT_MS,
    );

    // Honour cwd by prefixing `cd <rootDir>/<cwd> && …` (no native WorkingDir
    // over SSH). cwd is model input (schema-validated relative); rootDir is
    // resolved-absolute. Both are single-quoted so neither escapes into shell
    // syntax. The merged env (ADR-0004) is applied via `export` statements.
    const cwd = input.cwd ? `${conn.rootDir}/${input.cwd}` : conn.rootDir;
    const envPrefix = buildEnvPrefix(input.env);
    const command = `cd ${shQuote(cwd)} && ${envPrefix}${input.command}`;

    const res = await this.runExec(conn.client, command, timeoutMs);
    this.touchIdleTimer();

    const truncated =
      res.stdout.length >= MAX_SHELL_OUTPUT_BYTES ||
      res.stderr.length >= MAX_SHELL_OUTPUT_BYTES;

    return {
      stdout: res.stdout.toString("utf8"),
      stderr: res.stderr.toString("utf8"),
      exitCode: res.exitCode,
      truncated,
      durationMs: res.durationMs,
    };
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

  // `mkdir -p` the parent directories of a workspace-relative file path over
  // SFTP (which has no recursive mkdir). Each segment is stat-probed first and
  // created only if absent; the workspace root itself already exists. Literal
  // paths throughout — no shell.
  private async ensureParentDirs(
    sftp: SFTPWrapper,
    rootDir: string,
    relative: string,
  ): Promise<void> {
    const cleaned = relative.replace(/^\/+/, "");
    const idx = cleaned.lastIndexOf("/");
    if (idx === -1) return; // top-level file — parent is the (existing) root
    const segments = cleaned
      .slice(0, idx)
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

  async fsRead(
    _ctx: SandboxContext,
    input: FsReadInput,
  ): Promise<FsReadOutput> {
    const conn = await this.ensureConnection();
    const sftp = await this.getSftp(conn);
    const target = absPath(conn.rootDir, input.path);

    // Open, size, and read at most MAX_READ_BYTES. Reading min(size, cap) keeps
    // memory bounded and makes `truncated` use the same `>=` convention as the
    // Docker adapter (a file exactly at the cap reads `cap` bytes → truncated).
    const handle = await sftpOpen(sftp, target, "r");
    let raw: Buffer;
    try {
      const size = await sftpFstatSize(sftp, handle);
      const readLen = Math.min(size, MAX_READ_BYTES);
      raw = await sftpReadCapped(sftp, handle, readLen);
    } finally {
      await sftpClose(sftp, handle);
    }
    this.touchIdleTimer();

    const truncated = raw.length >= MAX_READ_BYTES;
    let content = decodeUtf8Strict(raw, "fs.read", input.path);

    // Optional line window. SFTP has no server-side `sed`, so we slice the
    // (already byte-capped) content in Node — each selected line is emitted with
    // a trailing newline, matching `sed -n 'a,bp'`. Caveat: for a file larger
    // than MAX_READ_BYTES the byte cap is hit before late lines are reached.
    if (input.lineRange) {
      const [start, end] = input.lineRange;
      const body = content.endsWith("\n") ? content.slice(0, -1) : content;
      const lines = body.length === 0 ? [] : body.split("\n");
      content = lines
        .slice(start - 1, end)
        .map((line) => `${line}\n`)
        .join("");
    }

    return { content, lineCount: countLines(content), truncated };
  }

  async fsWrite(
    _ctx: SandboxContext,
    input: FsWriteInput,
  ): Promise<FsWriteOutput> {
    const conn = await this.ensureConnection();
    const sftp = await this.getSftp(conn);
    const target = absPath(conn.rootDir, input.path);

    await this.ensureParentDirs(sftp, conn.rootDir, input.path);

    // `wx` fails atomically if the file exists (native create — no racy stat/open
    // window); `w` truncates-or-creates for overwrite (ADR-0012).
    const flag: OpenMode = input.mode === "create" ? "wx" : "w";
    const contentBuf = Buffer.from(input.content, "utf8");

    let handle: Buffer;
    try {
      handle = await sftpOpen(sftp, target, flag);
    } catch (err) {
      // Disambiguate the expected create-collision from a genuine open error
      // (e.g. permissions) by checking existence after the fact.
      if (input.mode === "create" && (await sftpStatExists(sftp, target))) {
        throw new Error(
          `fs.write: path already exists (mode=create): ${input.path}`,
          { cause: err },
        );
      }
      throw err;
    }
    try {
      await sftpWriteAll(sftp, handle, contentBuf);
    } finally {
      await sftpClose(sftp, handle);
    }
    this.touchIdleTimer();

    return { bytesWritten: contentBuf.length };
  }

  async fsEdit(
    _ctx: SandboxContext,
    input: FsEditInput,
  ): Promise<FsEditOutput> {
    const conn = await this.ensureConnection();
    const sftp = await this.getSftp(conn);
    const target = absPath(conn.rootDir, input.path);

    // Read (capped, matching the Docker adapter), replace a unique occurrence,
    // then overwrite. Same capped-read caveat as fs.read for very large files.
    const readHandle = await sftpOpen(sftp, target, "r");
    let raw: Buffer;
    try {
      const size = await sftpFstatSize(sftp, readHandle);
      raw = await sftpReadCapped(
        sftp,
        readHandle,
        Math.min(size, MAX_READ_BYTES),
      );
    } finally {
      await sftpClose(sftp, readHandle);
    }

    const original = decodeUtf8Strict(raw, "fs.edit", input.path);
    const first = original.indexOf(input.oldString);
    if (first === -1) {
      throw new Error(`fs.edit: oldString not found in ${input.path}`);
    }
    const second = original.indexOf(input.oldString, first + 1);
    if (second !== -1) {
      throw new Error(`fs.edit: oldString is not unique in ${input.path}`);
    }

    const updated =
      original.slice(0, first) +
      input.newString +
      original.slice(first + input.oldString.length);

    const writeHandle = await sftpOpen(sftp, target, "w");
    try {
      await sftpWriteAll(sftp, writeHandle, Buffer.from(updated, "utf8"));
    } finally {
      await sftpClose(sftp, writeHandle);
    }
    this.touchIdleTimer();

    return { replacements: 1 };
  }

  // fs.list is deferred to a follow-up slice (ADR-0012: `find -printf`).
  fsList(_ctx: SandboxContext, _input: FsListInput): Promise<FsListOutput> {
    return notImplemented("fs.list");
  }

  // destroy() is a no-op beyond disconnecting (ADR-0012): the host is not
  // Platypus-owned, so we never mutate its filesystem. Just tear down our
  // connection so no socket or idle timer leaks.
  destroy(_ctx: SandboxContext): Promise<void> {
    this.closeConnection();
    return Promise.resolve();
  }
}
