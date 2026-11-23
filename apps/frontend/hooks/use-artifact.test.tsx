import { beforeEach, describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const { read, calls } = vi.hoisted(() => {
  const value: { data?: unknown; error?: unknown } = {};
  return { read: { value }, calls: [] as unknown[][] };
});
vi.mock("./use-scoped-swr", () => ({
  useScopedSWR: (...args: unknown[]) => {
    calls.push(args);
    return read.value;
  },
}));

import { useStoredArtifact } from "./use-artifact";

const scope = { orgId: "org1", workspaceId: "ws1" };

beforeEach(() => {
  read.value = {};
  calls.length = 0;
});

describe("useStoredArtifact", () => {
  it("reads the version the write stored, in the Workspace's scope", () => {
    renderHook(() => useStoredArtifact({ id: "a1", version: 2 }, scope));

    expect(calls[0]).toEqual(["artifacts/a1?version=2", scope]);
  });

  it("withholds the read until a write has stored an Artifact", () => {
    renderHook(() => useStoredArtifact(undefined, scope));

    expect(calls[0]?.[1]).toBeNull();
  });

  it("reads a 404 as deleted, not as a failed read", () => {
    read.value = { error: { status: 404 } };

    expect(
      renderHook(() => useStoredArtifact({ id: "a1", version: 1 }, scope))
        .result.current.deleted,
    ).toBe(true);
  });

  it("keeps every other failure an error rather than a deletion", () => {
    read.value = { error: { status: 500 } };

    expect(
      renderHook(() => useStoredArtifact({ id: "a1", version: 1 }, scope))
        .result.current.deleted,
    ).toBe(false);
  });

  it("hands back the stored version's content once it lands", () => {
    const data = {
      artifact: { type: "markdown" },
      version: { content: "# 1" },
    };
    read.value = { data };

    expect(
      renderHook(() => useStoredArtifact({ id: "a1", version: 1 }, scope))
        .result.current,
    ).toEqual({ data, deleted: false });
  });
});
