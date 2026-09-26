import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import type { ToolExecuteFunction } from "ai";
import { createSandboxTools } from "./tools.ts";
import type { SandboxBackend, SandboxContext } from "./types.ts";

type TypedExecute = ToolExecuteFunction<
  Record<string, unknown>,
  unknown,
  unknown
>;

/** Call a tool's execute function without casting to `any`. */
function callExecute(
  tools: ReturnType<typeof createSandboxTools>,
  name: string,
  input: Record<string, unknown>,
  // Production always has a signal, so that is the default here. `null` is the
  // explicit "the SDK handed us none" case.
  abortSignal: AbortSignal | null = new AbortController().signal,
): Promise<unknown> {
  const fn = tools[name]?.execute as TypedExecute | undefined;
  if (!fn) throw new Error(`tool "${name}" has no execute function`);
  return Promise.resolve(
    fn(input, {
      toolCallId: "test",
      messages: [],
      context: {},
      abortSignal: abortSignal ?? undefined,
    }),
  );
}

const ctx: SandboxContext = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
};

/** Mocks held separately so destructuring never touches a method-typed interface. */
type BackendMocks = {
  shellExec: Mock;
  fsRead: Mock;
  fsWrite: Mock;
  fsEdit: Mock;
  fsList: Mock;
  destroy: Mock;
};

function makeBackend(): { backend: SandboxBackend; mocks: BackendMocks } {
  const mocks: BackendMocks = {
    shellExec: vi.fn().mockResolvedValue({
      stdout: "ok",
      stderr: "",
      exitCode: 0,
      truncated: false,
      durationMs: 5,
    }),
    fsRead: vi
      .fn()
      .mockResolvedValue({ content: "hello", lineCount: 1, truncated: false }),
    fsWrite: vi.fn().mockResolvedValue({ bytesWritten: 5 }),
    fsEdit: vi.fn().mockResolvedValue({ replacements: 1 }),
    fsList: vi.fn().mockResolvedValue({ entries: [], truncated: false }),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
  // Cast so we can pass a mock object that satisfies SandboxBackend.
  const backend = mocks as unknown as SandboxBackend;
  return { backend, mocks };
}

describe("createSandboxTools", () => {
  it("returns the five fixed-core tools", () => {
    const { backend } = makeBackend();
    const tools = createSandboxTools(backend, ctx);
    expect(Object.keys(tools).sort()).toEqual([
      "fsEdit",
      "fsList",
      "fsRead",
      "fsWrite",
      "shellExec",
    ]);
  });

  it("delegates shellExec to the backend with the sandbox context", async () => {
    const { backend, mocks } = makeBackend();
    const tools = createSandboxTools(backend, ctx);
    const result = await callExecute(tools, "shellExec", { command: "ls" });
    expect(mocks.shellExec).toHaveBeenCalledWith(
      ctx,
      { command: "ls" },
      {
        signal: expect.any(AbortSignal) as unknown,
      },
    );
    expect((result as { stdout: string }).stdout).toBe("ok");
  });

  it("delegates fsRead to the backend with the sandbox context", async () => {
    const { backend, mocks } = makeBackend();
    const tools = createSandboxTools(backend, ctx);
    const result = await callExecute(tools, "fsRead", { path: "README.md" });
    expect(mocks.fsRead).toHaveBeenCalledWith(
      ctx,
      { path: "README.md" },
      {
        signal: expect.any(AbortSignal) as unknown,
      },
    );
    expect((result as { content: string }).content).toBe("hello");
  });

  it("delegates fsWrite to the backend with the sandbox context", async () => {
    const { backend, mocks } = makeBackend();
    const tools = createSandboxTools(backend, ctx);
    await callExecute(tools, "fsWrite", {
      path: "a.txt",
      content: "hi",
      mode: "create",
    });
    expect(mocks.fsWrite).toHaveBeenCalledWith(
      ctx,
      { path: "a.txt", content: "hi", mode: "create" },
      { signal: expect.any(AbortSignal) as unknown },
    );
  });

  it("delegates fsEdit to the backend with the sandbox context", async () => {
    const { backend, mocks } = makeBackend();
    const tools = createSandboxTools(backend, ctx);
    await callExecute(tools, "fsEdit", {
      path: "a.txt",
      oldString: "foo",
      newString: "bar",
    });
    expect(mocks.fsEdit).toHaveBeenCalledWith(
      ctx,
      { path: "a.txt", oldString: "foo", newString: "bar" },
      { signal: expect.any(AbortSignal) as unknown },
    );
  });

  it("delegates fsList to the backend with the sandbox context", async () => {
    const { backend, mocks } = makeBackend();
    const tools = createSandboxTools(backend, ctx);
    await callExecute(tools, "fsList", { recursive: true });
    expect(mocks.fsList).toHaveBeenCalledWith(
      ctx,
      { recursive: true },
      {
        signal: expect.any(AbortSignal) as unknown,
      },
    );
  });

  it("does not touch input when workspace env is empty", async () => {
    const { backend, mocks } = makeBackend();
    const tools = createSandboxTools(backend, ctx, {});
    await callExecute(tools, "shellExec", { command: "ls", env: { A: "1" } });
    expect(mocks.shellExec).toHaveBeenCalledWith(
      ctx,
      { command: "ls", env: { A: "1" } },
      { signal: expect.any(AbortSignal) as unknown },
    );
  });

  it("merges workspace env on top of input.env (workspace wins on collision)", async () => {
    const { backend, mocks } = makeBackend();
    const tools = createSandboxTools(backend, ctx, {
      OPENAI_API_KEY: "sk-real",
      NODE_ENV: "production",
    });
    await callExecute(tools, "shellExec", {
      command: "node script.js",
      env: { OPENAI_API_KEY: "sk-spoof", FOO: "bar" },
    });
    expect(mocks.shellExec).toHaveBeenCalledWith(
      ctx,
      {
        command: "node script.js",
        env: {
          FOO: "bar",
          OPENAI_API_KEY: "sk-real",
          NODE_ENV: "production",
        },
      },
      { signal: expect.any(AbortSignal) as unknown },
    );
  });

  it("injects workspace env when input has no env field", async () => {
    const { backend, mocks } = makeBackend();
    const tools = createSandboxTools(backend, ctx, { GITHUB_TOKEN: "ghp-x" });
    await callExecute(tools, "shellExec", { command: "gh repo list" });
    expect(mocks.shellExec).toHaveBeenCalledWith(
      ctx,
      { command: "gh repo list", env: { GITHUB_TOKEN: "ghp-x" } },
      { signal: expect.any(AbortSignal) as unknown },
    );
  });
  it("hands the backend the run's signal alongside the context", async () => {
    const { backend, mocks } = makeBackend();
    const tools = createSandboxTools(backend, ctx);
    const controller = new AbortController();

    await callExecute(tools, "fsRead", { path: "a.txt" }, controller.signal);

    expect(mocks.fsRead).toHaveBeenCalledWith(
      ctx,
      { path: "a.txt" },
      { signal: controller.signal },
    );
  });

  // An adapter written before the appended parameter existed takes two
  // arguments and must keep working.
  it("runs a two-argument backend written before the signal existed", async () => {
    const backend = {
      shellExec: (_ctx: SandboxContext, input: { command: string }) =>
        Promise.resolve({
          stdout: input.command,
          stderr: "",
          exitCode: 0,
          truncated: false,
          durationMs: 1,
        }),
    } as unknown as SandboxBackend;

    const tools = createSandboxTools(backend, ctx);
    const result = await callExecute(
      tools,
      "shellExec",
      { command: "ls" },
      new AbortController().signal,
    );

    expect((result as { stdout: string }).stdout).toBe("ls");
  });

  // The AI SDK declares `abortSignal` optional. Nothing in core drives a turn
  // without one, but the options are required from API v3, so a call that
  // arrives without it still hands the adapter a signal — one that never fires.
  it("hands the backend a never-firing signal when the SDK supplies none", async () => {
    const { backend, mocks } = makeBackend();
    const tools = createSandboxTools(backend, ctx);

    await callExecute(tools, "fsList", { recursive: true }, null);

    expect(mocks.fsList).toHaveBeenCalledWith(
      ctx,
      { recursive: true },
      { signal: expect.any(AbortSignal) as unknown },
    );
    const [, , options] = mocks.fsList.mock.calls[0] as [
      unknown,
      unknown,
      { signal: AbortSignal },
    ];
    expect(options.signal.aborted).toBe(false);
  });

  // Issue #921. The turn not being pinned open cannot rest on the adapter's
  // cooperation: a backend that never settles must not hold the tool call open.
  it("rejects when the run aborts while a backend call is still in flight", async () => {
    const backend = {
      shellExec: () => new Promise<never>(() => {}),
    } as unknown as SandboxBackend;

    const tools = createSandboxTools(backend, ctx);
    const controller = new AbortController();
    const inflight = callExecute(
      tools,
      "shellExec",
      { command: "sleep 300" },
      controller.signal,
    );

    controller.abort();

    await expect(inflight).rejects.toThrow(/cancelled/i);
  });

  it("does not call the backend at all when the signal has already aborted", async () => {
    const { backend, mocks } = makeBackend();
    const tools = createSandboxTools(backend, ctx);
    const controller = new AbortController();
    controller.abort();

    await expect(
      callExecute(tools, "fsList", {}, controller.signal),
    ).rejects.toThrow(/cancelled/i);
    expect(mocks.fsList).not.toHaveBeenCalled();
  });
});

describe("fsDownload", () => {
  const withReadBytes = () => {
    const { mocks } = makeBackend();
    const fsReadBytes = vi.fn();
    return {
      backend: { ...mocks, fsReadBytes } as unknown as SandboxBackend,
      mocks,
      fsReadBytes,
    };
  };

  it("is offered only when the backend implements fsReadBytes", () => {
    expect(createSandboxTools(makeBackend().backend, ctx)).not.toHaveProperty(
      "fsDownload",
    );
    expect(createSandboxTools(withReadBytes().backend, ctx)).toHaveProperty(
      "fsDownload",
    );
  });

  it("returns the path and size, and no URL, without reading the bytes", async () => {
    const { backend, mocks, fsReadBytes } = withReadBytes();
    mocks.fsList.mockResolvedValue({
      entries: [{ path: "report.pdf", type: "file", size: 1234 }],
      truncated: false,
    });
    const result = await callExecute(
      createSandboxTools(backend, ctx),
      "fsDownload",
      { path: "out/report.pdf" },
    );
    expect(result).toEqual({ path: "out/report.pdf", size: 1234 });
    expect(JSON.stringify(result)).not.toMatch(/https?:|\/sandbox\/file/);
    expect(mocks.fsList).toHaveBeenCalledWith(
      ctx,
      { path: "out", glob: "report.pdf" },
      { signal: expect.any(AbortSignal) as unknown },
    );
    expect(fsReadBytes).not.toHaveBeenCalled();
  });

  it("errors on a missing path", async () => {
    const { backend } = withReadBytes();
    await expect(
      callExecute(createSandboxTools(backend, ctx), "fsDownload", {
        path: "nope.txt",
      }),
    ).rejects.toThrow(/no such file.*nope\.txt/i);
  });

  it("errors on a directory", async () => {
    const { backend, mocks } = withReadBytes();
    mocks.fsList.mockResolvedValue({
      entries: [{ path: "out", type: "dir" }],
      truncated: false,
    });
    await expect(
      callExecute(createSandboxTools(backend, ctx), "fsDownload", {
        path: "out",
      }),
    ).rejects.toThrow(/directory/i);
  });

  it("errors on a file over the transfer bound, naming the bound", async () => {
    const { backend, mocks } = withReadBytes();
    mocks.fsList.mockResolvedValue({
      entries: [{ path: "big.bin", type: "file", size: 25 * 1024 * 1024 + 1 }],
      truncated: false,
    });
    await expect(
      callExecute(createSandboxTools(backend, ctx), "fsDownload", {
        path: "big.bin",
      }),
    ).rejects.toThrow(/25 MiB/);
  });
});
