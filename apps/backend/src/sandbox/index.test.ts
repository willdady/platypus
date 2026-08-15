import { beforeEach, describe, it, expect } from "vitest";
import { z } from "zod";
import {
  clearSandboxBackends,
  registerSandboxBackend,
  getSandboxBackend,
  getSandboxBackends,
} from "./index.ts";
import type { SandboxBackend, SandboxBackendRegistration } from "./types.ts";

const stubBackend: SandboxBackend = {
  shellExec: () =>
    Promise.resolve({
      stdout: "",
      stderr: "",
      exitCode: 0,
      truncated: false,
      durationMs: 0,
    }),
  fsRead: () =>
    Promise.resolve({ content: "", lineCount: 0, truncated: false }),
  fsWrite: () => Promise.resolve({ bytesWritten: 0 }),
  fsEdit: () => Promise.resolve({ replacements: 1 }),
  fsList: () => Promise.resolve({ entries: [], truncated: false }),
  destroy: () => Promise.resolve(),
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

// The store's own contract — miss semantics, duplicate rejection, prototype-key
// safety, listing, reset — is covered once in
// `registry/contribution-registry.test.ts`. What is left here is what this
// instance adds: keying on the registration's own `backend` discriminator.
describe("sandbox backend registry", () => {
  beforeEach(() => {
    clearSandboxBackends();
  });

  it("keys a registration on its own backend id", () => {
    registerSandboxBackend(makeRegistration("test-lookup"));
    const found = getSandboxBackend("test-lookup");
    expect(found?.backend).toBe("test-lookup");
    expect(found?.name).toBe("Test test-lookup");
    expect(getSandboxBackends().map((r) => r.backend)).toEqual(["test-lookup"]);
  });

  it("refuses a second registration under the same backend id", () => {
    registerSandboxBackend(makeRegistration("test-duplicate"));
    expect(() =>
      registerSandboxBackend(makeRegistration("test-duplicate")),
    ).toThrow("Sandbox backend 'test-duplicate' has already been registered.");
  });
});
