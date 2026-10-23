import { posix } from "node:path";
import { tool, type Tool } from "ai";
import { z } from "zod";
import { SANDBOX_TRANSFER_MAX_BYTES } from "@platypuschat/plugin-sdk";
import { formatFileSize } from "@platypus/schemas";
import { raceCancellation } from "./transport.ts";
import { findEntry, TRANSFER_BOUND } from "./find-entry.ts";
import { classifyFilePart } from "../services/file-classification.ts";
import { fileTextForModel } from "../services/file-gate.ts";
import {
  relativePathSchema,
  fsEditInputSchema,
  fsListInputSchema,
  fsReadInputSchema,
  fsWriteInputSchema,
  shellExecInputSchema,
  type SandboxBackend,
  type SandboxCallOptions,
  type SandboxContext,
} from "./types.ts";

/**
 * Run one backend call under the run's abort signal (issue #921).
 *
 * The signal is passed on as {@link SandboxCallOptions} so a cooperative
 * adapter can stop the command itself, and the call is **raced** against the
 * same signal so one that ignores it cannot hold the turn open. Without the
 * race, an abort during a `shell.exec` left the executor promise pending
 * forever, the drive's snapshot stream never drained, and the run's terminal
 * write never happened — stranding the chat row on `running` with both run
 * timers already cleared, so nothing was left to recover it.
 *
 * A turn with no signal at all — nothing in core drives one, but the AI SDK
 * declares `abortSignal` optional — hands the adapter a signal that never
 * fires, since the options are required from plugin API v3.
 */
const underSignal = <T>(
  options: { abortSignal?: AbortSignal },
  call: (callOptions: SandboxCallOptions) => Promise<T>,
): Promise<T> => {
  const signal = options.abortSignal ?? new AbortController().signal;
  return raceCancellation(signal, () => call({ signal }));
};

/**
 * The size of the file at `path`, after checking it is a file within the
 * transfer bound; a tool error naming the reason otherwise. `use` names the
 * limit in that error ("download", "viewing").
 */
const transferableFileSize = async (
  backend: SandboxBackend,
  ctx: SandboxContext,
  path: string,
  signal: AbortSignal,
  use: string,
): Promise<number | undefined> => {
  const entry = await findEntry(backend, ctx, path, signal);
  if (!entry) throw new Error(`No such file: ${path}`);
  if (entry.type !== "file") {
    throw new Error(`${path} is a directory, not a file`);
  }
  if ((entry.size ?? 0) > SANDBOX_TRANSFER_MAX_BYTES) {
    throw new Error(
      `${path} is larger than the ${TRANSFER_BOUND} ${use} limit`,
    );
  }
  return entry.size;
};

/**
 * Offers a Sandbox file to the User as a download (ADR-0027). Core-built over
 * `fsList`, not an adapter method: it only checks the file is there and within
 * the transfer bound. The result deliberately carries no URL — the chat
 * renders it as a button that builds the link itself, so the model never has
 * a link to paste or pass on.
 */
export const createFsDownloadTool = (
  backend: SandboxBackend,
  ctx: SandboxContext,
) =>
  tool({
    description: `Offer a file from the sandbox to the user as a download button in the chat. This does not return the file's contents — use it for binary or large files the user wants to keep, up to ${TRANSFER_BOUND}. Returns the path and its size in bytes.`,
    inputSchema: z.object({
      path: relativePathSchema.describe(
        "Path of the file to offer, relative to the workspace root",
      ),
    }),
    execute: ({ path }, options) =>
      underSignal(options, async ({ signal }) => {
        const size = await transferableFileSize(
          backend,
          ctx,
          path,
          signal,
          "download",
        );
        return { path, size };
      }),
  });

/**
 * How the turn's model reads files: the media types it takes natively, and how
 * much extracted document text it may be sent. Resolved by the caller for the
 * turn's (Provider, model) pair — a Sub-Agent's own, on a delegate's session.
 */
export type ModelFileReading = {
  passthroughFileTypes: string[];
  maxExtractedTextChars?: number;
};

/**
 * Media types by extension, for the files `fsView` sends. The extension is the
 * only signal, the same trust the composer gives an attached file; anything
 * unlisted is `application/octet-stream`, and a text file still reads as text
 * because classification goes by its extension, not this type.
 */
const MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  json: "application/json",
  csv: "text/csv",
  md: "text/markdown",
  txt: "text/plain",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
};

const mediaTypeForPath = (path: string): string =>
  MEDIA_TYPES[posix.extname(path).slice(1).toLowerCase()] ??
  "application/octet-stream";

// `ai` does not export the tool-result output type, so it is read off `Tool`.
type ModelContent = Extract<
  Awaited<ReturnType<NonNullable<Tool["toModelOutput"]>>>,
  { type: "content" }
>["value"];

/**
 * Sends a Sandbox file to the model as a file, so it can see an image or PDF
 * it made (ADR-0038). The bytes go to the model request only: `execute` holds
 * what the model will receive in memory for the turn, keyed by tool call, and
 * returns metadata alone — that is what is streamed and saved, so the
 * Transcript never holds the file. `toModelOutput` is the one place the bytes
 * enter a model request.
 *
 * A file the model takes natively goes as is; otherwise a text file is
 * inlined and a PDF/DOCX extracted, exactly as for a File part. Anything else
 * is a tool error. The model content always leads with a text part naming the
 * file, so a Provider that drops the file still leaves the model knowing one
 * should have arrived.
 */
export const createFsViewTool = (
  backend: SandboxBackend,
  ctx: SandboxContext,
  fileReading: () => Promise<ModelFileReading>,
) => {
  // Narrowed to the parts built here: against the full union, which still
  // carries the deprecated `file-data`-style parts, no-deprecated flags `type`.
  const viewed = new Map<
    string,
    Extract<ModelContent[number], { type: "text" | "file" }>[]
  >();
  return tool({
    description: `Look at a file from the sandbox — an image, a PDF, or a text file — as the file itself, up to ${TRANSFER_BOUND}. Use it to check an image or document you generated. Returns the path, size and media type; the file is attached for you to see.`,
    inputSchema: z.object({
      path: relativePathSchema.describe(
        "Path of the file to view, relative to the workspace root",
      ),
    }),
    execute: ({ path }, options) =>
      underSignal(options, async ({ signal }) => {
        await transferableFileSize(backend, ctx, path, signal, "viewing");
        const [bytes, reading] = await Promise.all([
          backend.fsReadBytes!(
            ctx,
            { path, maxBytes: SANDBOX_TRANSFER_MAX_BYTES },
            { signal },
          ),
          fileReading(),
        ]);
        const filename = posix.basename(path);
        const mediaType = mediaTypeForPath(path);
        const file = { filename, mediaType };
        const outcome = classifyFilePart(
          file,
          reading.passthroughFileTypes,
          bytes,
        );
        if (outcome === "reject") {
          throw new Error(`This model cannot read ${mediaType} files`);
        }
        viewed.set(options.toolCallId, [
          {
            type: "text",
            text: `\`${filename}\` (${mediaType}, ${formatFileSize(bytes.length)}) attached below.`,
          },
          outcome === "passthrough"
            ? { type: "file", data: { type: "data", data: bytes }, ...file }
            : {
                type: "text",
                text: await fileTextForModel(bytes, file, outcome, reading),
              },
        ]);
        return { path, size: bytes.length, mediaType };
      }),
    toModelOutput: ({ toolCallId, output }) => {
      const content = viewed.get(toolCallId);
      // Only reachable for a result this turn did not produce — history is
      // converted without tools — so the saved metadata is all there is.
      return content
        ? { type: "content", value: content }
        : { type: "json", value: output };
    },
  });
};

// Builds the five AI SDK Tool objects from a SandboxBackend instance and the
// per-turn context, plus `fsDownload` and `fsView` when the backend implements
// `fsReadBytes`. Descriptions are intentionally terse; the higher-level
// orientation (workspace root, persistence across turns, stateless shell) is
// rendered into the system prompt by ./system-prompt-fragment.ts.
//
// `workspaceEnv` is the workspace-default env map (see ADR-0004). It is merged
// on top of `input.env` for every `shell.exec` call (workspace wins), so secret
// values never need to transit the LLM. Merge happens here, above the adapter,
// to keep the SandboxBackend contract adapter-agnostic.
export const createSandboxTools = (
  backend: SandboxBackend,
  ctx: SandboxContext,
  workspaceEnv: Record<string, string> = {},
  fileReading: () => Promise<ModelFileReading> = () =>
    Promise.resolve({ passthroughFileTypes: [] }),
): Record<string, Tool> => ({
  shellExec: tool({
    description:
      "Run a shell command in the sandbox. Each call starts a fresh shell — there is no persistent shell state between calls. Pass `cwd` (relative to the workspace root) to choose the working directory. Output is capped; check the `truncated` flag.",
    inputSchema: shellExecInputSchema,
    execute: (input, options) =>
      underSignal(options, (callOptions) => {
        if (Object.keys(workspaceEnv).length === 0) {
          return backend.shellExec(ctx, input, callOptions);
        }
        const mergedEnv = { ...(input.env ?? {}), ...workspaceEnv };
        return backend.shellExec(
          ctx,
          { ...input, env: mergedEnv },
          callOptions,
        );
      }),
  }),

  fsRead: tool({
    description:
      "Read a UTF-8 text file from the sandbox. Paths are relative to the workspace root. Pass `lineRange: [start, end]` (1-indexed, inclusive) to read a slice. Large files are truncated.",
    inputSchema: fsReadInputSchema,
    execute: (input, options) =>
      underSignal(options, (callOptions) =>
        backend.fsRead(ctx, input, callOptions),
      ),
  }),

  fsWrite: tool({
    description:
      'Write a UTF-8 text file in the sandbox. `mode: "create"` fails if the file already exists; `mode: "overwrite"` replaces it. Parent directories are created automatically.',
    inputSchema: fsWriteInputSchema,
    execute: (input, options) =>
      underSignal(options, (callOptions) =>
        backend.fsWrite(ctx, input, callOptions),
      ),
  }),

  fsEdit: tool({
    description:
      "Edit a file by replacing exactly one occurrence of `oldString` with `newString`. Fails if `oldString` is absent or appears more than once. Prefer this over rewriting whole files.",
    inputSchema: fsEditInputSchema,
    execute: (input, options) =>
      underSignal(options, (callOptions) =>
        backend.fsEdit(ctx, input, callOptions),
      ),
  }),

  fsList: tool({
    description:
      'List files and directories in the sandbox. Pass `recursive: true` to descend, and `glob` (e.g. "**/*.ts") to filter. Output is capped; check the `truncated` flag.',
    inputSchema: fsListInputSchema,
    execute: (input, options) =>
      underSignal(options, (callOptions) =>
        backend.fsList(ctx, input, callOptions),
      ),
  }),

  ...(backend.fsReadBytes
    ? {
        fsDownload: createFsDownloadTool(backend, ctx),
        fsView: createFsViewTool(backend, ctx, fileReading),
      }
    : {}),
});
