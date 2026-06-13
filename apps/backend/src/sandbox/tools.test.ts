import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import type { ToolExecuteFunction } from "ai";
import { createSandboxTools } from "./tools.ts";
import type { SandboxBackend, SandboxContext } from "./types.ts";

type TypedExecute = ToolExecuteFunction<Record<string, unknown>, unknown>;

/** Call a tool's execute function without casting to `any`. */
function callExecute(
  tools: ReturnType<typeof createSandboxTools>,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const fn = tools[name]?.execute as TypedExecute | undefined;
  if (!fn) throw new Error(`tool "${name}" has no execute function`);
  return Promise.resolve(fn(input, {}));
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
    expect(mocks.shellExec).toHaveBeenCalledWith(ctx, { command: "ls" });
    expect((result as { stdout: string }).stdout).toBe("ok");
  });

  it("delegates fsRead to the backend with the sandbox context", async () => {
    const { backend, mocks } = makeBackend();
    const tools = createSandboxTools(backend, ctx);
    const result = await callExecute(tools, "fsRead", { path: "README.md" });
    expect(mocks.fsRead).toHaveBeenCalledWith(ctx, { path: "README.md" });
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
    expect(mocks.fsWrite).toHaveBeenCalledWith(ctx, {
      path: "a.txt",
      content: "hi",
      mode: "create",
    });
  });

  it("delegates fsEdit to the backend with the sandbox context", async () => {
    const { backend, mocks } = makeBackend();
    const tools = createSandboxTools(backend, ctx);
    await callExecute(tools, "fsEdit", {
      path: "a.txt",
      oldString: "foo",
      newString: "bar",
    });
    expect(mocks.fsEdit).toHaveBeenCalledWith(ctx, {
      path: "a.txt",
      oldString: "foo",
      newString: "bar",
    });
  });

  it("delegates fsList to the backend with the sandbox context", async () => {
    const { backend, mocks } = makeBackend();
    const tools = createSandboxTools(backend, ctx);
    await callExecute(tools, "fsList", { recursive: true });
    expect(mocks.fsList).toHaveBeenCalledWith(ctx, { recursive: true });
  });

  it("does not touch input when workspace env is empty", async () => {
    const { backend, mocks } = makeBackend();
    const tools = createSandboxTools(backend, ctx, {});
    await callExecute(tools, "shellExec", { command: "ls", env: { A: "1" } });
    expect(mocks.shellExec).toHaveBeenCalledWith(ctx, {
      command: "ls",
      env: { A: "1" },
    });
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
    expect(mocks.shellExec).toHaveBeenCalledWith(ctx, {
      command: "node script.js",
      env: {
        FOO: "bar",
        OPENAI_API_KEY: "sk-real",
        NODE_ENV: "production",
      },
    });
  });

  it("injects workspace env when input has no env field", async () => {
    const { backend, mocks } = makeBackend();
    const tools = createSandboxTools(backend, ctx, { GITHUB_TOKEN: "ghp-x" });
    await callExecute(tools, "shellExec", { command: "gh repo list" });
    expect(mocks.shellExec).toHaveBeenCalledWith(ctx, {
      command: "gh repo list",
      env: { GITHUB_TOKEN: "ghp-x" },
    });
  });
});
