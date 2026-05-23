import { tool, type Tool } from "ai";
import {
  fsEditInputSchema,
  fsListInputSchema,
  fsReadInputSchema,
  fsWriteInputSchema,
  shellExecInputSchema,
  type SandboxBackend,
  type SandboxContext,
} from "./types.ts";

// Builds the five AI SDK Tool objects from a SandboxBackend instance and the
// per-turn context. Descriptions are intentionally terse; the higher-level
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
): Record<string, Tool> => ({
  shellExec: tool({
    description:
      "Run a shell command in the sandbox. Each call starts a fresh shell — there is no persistent shell state between calls. Pass `cwd` (relative to the workspace root) to choose the working directory. Output is capped; check the `truncated` flag.",
    inputSchema: shellExecInputSchema,
    execute: (input) => {
      if (Object.keys(workspaceEnv).length === 0) {
        return backend.shellExec(ctx, input);
      }
      const mergedEnv = { ...(input.env ?? {}), ...workspaceEnv };
      return backend.shellExec(ctx, { ...input, env: mergedEnv });
    },
  }),

  fsRead: tool({
    description:
      "Read a UTF-8 text file from the sandbox. Paths are relative to the workspace root. Pass `lineRange: [start, end]` (1-indexed, inclusive) to read a slice. Large files are truncated.",
    inputSchema: fsReadInputSchema,
    execute: (input) => backend.fsRead(ctx, input),
  }),

  fsWrite: tool({
    description:
      'Write a UTF-8 text file in the sandbox. `mode: "create"` fails if the file already exists; `mode: "overwrite"` replaces it. Parent directories are created automatically.',
    inputSchema: fsWriteInputSchema,
    execute: (input) => backend.fsWrite(ctx, input),
  }),

  fsEdit: tool({
    description:
      "Edit a file by replacing exactly one occurrence of `oldString` with `newString`. Fails if `oldString` is absent or appears more than once. Prefer this over rewriting whole files.",
    inputSchema: fsEditInputSchema,
    execute: (input) => backend.fsEdit(ctx, input),
  }),

  fsList: tool({
    description:
      'List files and directories in the sandbox. Pass `recursive: true` to descend, and `glob` (e.g. "**/*.ts") to filter. Output is capped; check the `truncated` flag.',
    inputSchema: fsListInputSchema,
    execute: (input) => backend.fsList(ctx, input),
  }),
});
