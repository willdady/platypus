import { raceAbort } from "../utils/abort-race.ts";
import type { SandboxContext } from "./types.ts";

export interface SandboxExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number;
  stdoutCap: StreamCap;
  stderrCap: StreamCap;
  signal: AbortSignal;
}

export interface SandboxExecResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
  durationMs: number;
}

export interface StreamCap {
  head: number;
  tail?: number;
}

const isContinuationByte = (byte: number): boolean => (byte & 0xc0) === 0x80;

const utf8SequenceLength = (byte: number): number => {
  if (byte < 0x80) return 1;
  if ((byte & 0xe0) === 0xc0) return 2;
  if ((byte & 0xf0) === 0xe0) return 3;
  if ((byte & 0xf8) === 0xf0) return 4;
  return 0;
};

const utf8HeadEnd = (bytes: Buffer): number => {
  for (let back = 1; back <= 4 && back <= bytes.length; back++) {
    const start = bytes.length - back;
    const byte = bytes.readUInt8(start);
    if (isContinuationByte(byte)) continue;
    const length = utf8SequenceLength(byte);
    if (length === 0) return bytes.length;
    return start + length <= bytes.length ? bytes.length : start;
  }
  return bytes.length;
};

const utf8TailStart = (bytes: Buffer): number => {
  let start = 0;
  while (
    start < 3 &&
    start < bytes.length &&
    isContinuationByte(bytes.readUInt8(start))
  )
    start++;
  return start;
};

const createTailBuffer = (capacity: number) => {
  const buffer = Buffer.allocUnsafe(capacity);
  let write = 0;
  let filled = 0;

  return {
    push(chunk: Buffer): void {
      if (buffer.length === 0 || chunk.length === 0) return;
      const bytes =
        chunk.length > buffer.length
          ? chunk.subarray(chunk.length - buffer.length)
          : chunk;
      const first = Math.min(bytes.length, buffer.length - write);
      bytes.copy(buffer, write, 0, first);
      if (first < bytes.length) bytes.copy(buffer, 0, first);
      write = (write + bytes.length) % buffer.length;
      filled = Math.min(buffer.length, filled + bytes.length);
    },
    toBuffer(): Buffer {
      if (filled < buffer.length) return buffer.subarray(0, filled);
      return Buffer.concat([buffer.subarray(write), buffer.subarray(0, write)]);
    },
  };
};

const omittedMarker = (bytes: number): string =>
  `\n[… ${bytes.toLocaleString("en-US")} bytes omitted …]\n`;

export const createCappedSink = (cap: StreamCap) => {
  const headChunks: Buffer[] = [];
  let headBytes = 0;
  const tailCapacity = cap.tail ?? 0;
  const keepTail = cap.tail !== undefined;
  const tail = createTailBuffer(tailCapacity);
  let totalBytes = 0;

  return {
    push(chunk: Buffer): void {
      totalBytes += chunk.length;
      if (headBytes < cap.head) {
        const room = cap.head - headBytes;
        const taken = chunk.length <= room ? chunk : chunk.subarray(0, room);
        // why: a subarray view would pin the caller's whole chunk in memory
        headChunks.push(taken === chunk ? taken : Buffer.from(taken));
        headBytes += taken.length;
      }
      if (keepTail) tail.push(chunk);
    },
    collect(): Buffer {
      const head = Buffer.concat(headChunks);
      if (!keepTail) return head;

      const tailBytes = tail.toBuffer();
      const budget = cap.head + tailCapacity;
      if (totalBytes <= budget) {
        if (totalBytes <= headBytes) return head;
        const tailStart = totalBytes - tailBytes.length;
        return Buffer.concat([
          head,
          tailBytes.subarray(Math.max(0, headBytes - tailStart)),
        ]);
      }

      const keptHead = head.subarray(0, utf8HeadEnd(head));
      const keptTail = tailBytes.subarray(utf8TailStart(tailBytes));
      return Buffer.concat([
        keptHead,
        Buffer.from(
          omittedMarker(totalBytes - keptHead.length - keptTail.length),
        ),
        keptTail,
      ]);
    },
  };
};

export const shQuote = (value: string): string =>
  `'${value.replace(/'/g, `'\\''`)}'`;

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const toShellCommand = (
  argv: string[],
  opts: Pick<SandboxExecOptions, "cwd" | "env">,
): string => {
  const envPrefix = Object.entries(opts.env ?? {})
    .filter(([k]) => ENV_KEY_PATTERN.test(k))
    .map(([k, v]) => `export ${k}=${shQuote(v)}; `)
    .join("");
  const cdPrefix = opts.cwd ? `cd ${shQuote(opts.cwd)} && ` : "";
  return `${envPrefix}${cdPrefix}${argv.map(shQuote).join(" ")}`;
};

export class SandboxPathExistsError extends Error {
  constructor(absPath: string, options?: { cause?: unknown }) {
    super(`path already exists: ${absPath}`, options);
    this.name = "SandboxPathExistsError";
  }
}

export class SandboxCancelledError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("sandbox: turn cancelled", options);
    this.name = "SandboxCancelledError";
  }
}

export const raceCancellation = <T>(
  signal: AbortSignal | undefined,
  work: () => Promise<T>,
): Promise<T> => {
  if (!signal) return work();
  return raceAbort(signal, work).catch((cause) => {
    if (signal.aborted) throw new SandboxCancelledError({ cause });
    throw cause;
  });
};

export interface SandboxTransport {
  rootDir(ctx: SandboxContext): Promise<string>;

  exec(
    ctx: SandboxContext,
    argv: string[],
    opts: SandboxExecOptions,
  ): Promise<SandboxExecResult>;

  readFile(
    ctx: SandboxContext,
    absPath: string,
    cap: number,
    signal: AbortSignal,
  ): Promise<Buffer>;

  writeFile(
    ctx: SandboxContext,
    absPath: string,
    bytes: Buffer,
    mode: "create" | "overwrite",
  ): Promise<void>;

  destroy(ctx: SandboxContext): Promise<void>;

  close?(): Promise<void>;
}
