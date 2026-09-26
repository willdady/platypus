import { posix } from "node:path";
import { SANDBOX_TRANSFER_MAX_BYTES } from "@platypuschat/plugin-sdk";
import type { FsListEntry, SandboxBackend, SandboxContext } from "./types.ts";

/** The transfer bound as a reader sees it, e.g. "25 MiB". */
export const TRANSFER_BOUND = `${SANDBOX_TRANSFER_MAX_BYTES / (1024 * 1024)} MiB`;

/**
 * The entry for `path` in a listing of its parent directory, or undefined when
 * there is none. The glob narrows the listing past its entry cap whenever the
 * name is safe to use as a pattern.
 */
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
    // fsList reports a missing parent only as a rejection. Confirm that is
    // what this was, so any other failure fails the request instead of reading
    // as "no such file" — which, for an upload, would overwrite unasked.
    if (dir === ".") throw err;
    const parent = await findEntry(backend, ctx, dir, signal);
    if (parent?.type === "dir") throw err;
    return undefined;
  }
};
