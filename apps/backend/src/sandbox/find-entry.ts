import { posix } from "node:path";
import { SANDBOX_TRANSFER_MAX_BYTES } from "@platypuschat/plugin-sdk";
import type { FsListEntry, SandboxBackend, SandboxContext } from "./types.ts";

export const TRANSFER_BOUND = `${SANDBOX_TRANSFER_MAX_BYTES / (1024 * 1024)} MiB`;

export const findEntry = async (
  backend: SandboxBackend,
  ctx: SandboxContext,
  path: string,
  signal: AbortSignal,
): Promise<FsListEntry | undefined> => {
  const dir = posix.dirname(path);
  const name = posix.basename(path);
  try {
    const { entries } = await backend.fsList(
      ctx,
      {
        ...(dir === "." ? {} : { path: dir }),
        ...(/[*?[\]\\]/.test(name) ? {} : { glob: name }),
      },
      { signal },
    );
    return entries.find((e) => e.path === name);
  } catch (err) {
    if (dir === ".") throw err;
    const parent = await findEntry(backend, ctx, dir, signal);
    if (parent?.type === "dir") throw err;
    return undefined;
  }
};
