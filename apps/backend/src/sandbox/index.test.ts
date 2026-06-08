import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  registerSandboxBackend,
  getSandboxBackend,
  getSandboxBackends,
} from "./index.ts";
import type { SandboxBackend, SandboxBackendRegistration } from "./types.ts";

const stubBackend: SandboxBackend = {
  shellExec: async () => ({
    stdout: "",
    stderr: "",
    exitCode: 0,
    truncated: false,
    durationMs: 0,
  }),
  fsRead: async () => ({ content: "", lineCount: 0, truncated: false }),
  fsWrite: async () => ({ bytesWritten: 0 }),
  fsEdit: async () => ({ replacements: 1 }),
  fsList: async () => ({ entries: [], truncated: false }),
  destroy: async () => {},
};

const makeRegistration = (
  backend: string,
): SandboxBackendRegistration<unknown, unknown> => ({
  backend,
  name: `Test ${backend}`,
  configSchema: z.unknown(),
  credentialsSchema: z.unknown(),
  create: () => stubBackend,
});

// The registry is module-level state; we reset by re-importing via vi.resetModules
// isn't trivial here, so each test uses a unique backend id.

describe("sandbox backend registry", () => {
  it("registers and looks up a backend by id", () => {
    registerSandboxBackend(makeRegistration("test-lookup"));
    const found = getSandboxBackend("test-lookup");
    expect(found?.backend).toBe("test-lookup");
    expect(found?.name).toBe("Test test-lookup");
  });

  it("returns undefined for an unknown backend", () => {
    expect(getSandboxBackend("does-not-exist")).toBeUndefined();
  });

  it("rejects duplicate registration of the same backend id", () => {
    registerSandboxBackend(makeRegistration("test-duplicate"));
    expect(() =>
      registerSandboxBackend(makeRegistration("test-duplicate")),
    ).toThrow(/already been registered/);
  });

  it("lists all registered backends", () => {
    registerSandboxBackend(makeRegistration("test-list-a"));
    registerSandboxBackend(makeRegistration("test-list-b"));
    const ids = getSandboxBackends().map((r) => r.backend);
    expect(ids).toContain("test-list-a");
    expect(ids).toContain("test-list-b");
  });
});
