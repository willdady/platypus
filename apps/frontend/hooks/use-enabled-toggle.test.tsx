import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { WriteOutcome } from "@/lib/api-write";

vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://test",
}));

const { toastErrorSpy, writeEntitySpy } = vi.hoisted(() => ({
  toastErrorSpy: vi.fn(),
  writeEntitySpy: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: toastErrorSpy } }));
vi.mock("@/lib/api-write", () => ({ writeEntity: writeEntitySpy }));

import { useEnabledToggle } from "./use-enabled-toggle";

type Row = { id: string; enabled: boolean };
const rows: Row[] = [
  { id: "a", enabled: true },
  { id: "b", enabled: false },
];
const success: WriteOutcome<unknown> = {
  outcome: "success",
  data: null,
  revalidateKeys: [],
};

/** A write that resolves only when the test says so. */
function deferredWrite() {
  let resolve!: (outcome: WriteOutcome<unknown>) => void;
  writeEntitySpy.mockImplementationOnce(
    () => new Promise((r) => (resolve = r)),
  );
  return (outcome: WriteOutcome<unknown>) => resolve(outcome);
}

function setup() {
  const mutate = vi.fn().mockResolvedValue(undefined);
  const { result } = renderHook(() =>
    useEnabledToggle<Row>({
      entity: "webhooks",
      scope: { orgId: "o", workspaceId: "w" },
      mutate,
    }),
  );
  return { result, mutate };
}

describe("useEnabledToggle", () => {
  beforeEach(() => vi.clearAllMocks());

  it("flips the row before the write resolves, then revalidates", async () => {
    const finish = deferredWrite();
    const { result, mutate } = setup();

    let done!: Promise<void>;
    act(() => {
      done = result.current.toggle(rows[0]);
    });

    expect(result.current.apply(rows)[0].enabled).toBe(false);
    expect(result.current.isToggling("a")).toBe(true);
    expect(writeEntitySpy).toHaveBeenCalledWith(
      "http://test",
      "webhooks",
      { orgId: "o", workspaceId: "w" },
      { id: "a", data: { enabled: false } },
    );

    await act(async () => {
      finish(success);
      await done;
    });

    expect(mutate).toHaveBeenCalledOnce();
    expect(result.current.isToggling("a")).toBe(false);
  });

  it("reverts a refused toggle and toasts the reason", async () => {
    const finish = deferredWrite();
    const { result, mutate } = setup();

    let done!: Promise<void>;
    act(() => {
      done = result.current.toggle(rows[1]);
    });
    expect(result.current.apply(rows)[1].enabled).toBe(true);

    await act(async () => {
      finish({ outcome: "forbidden", message: "Not yours" });
      await done;
    });

    expect(result.current.apply(rows)[1].enabled).toBe(false);
    expect(result.current.isToggling("b")).toBe(false);
    expect(toastErrorSpy).toHaveBeenCalledWith("Not yours");
    expect(mutate).not.toHaveBeenCalled();
  });

  it("keeps each row pending until its own write resolves", async () => {
    const finishA = deferredWrite();
    const finishB = deferredWrite();
    const { result } = setup();

    let doneA!: Promise<void>;
    let doneB!: Promise<void>;
    act(() => {
      doneA = result.current.toggle(rows[0]);
    });
    act(() => {
      doneB = result.current.toggle(rows[1]);
    });
    expect(result.current.isToggling("a")).toBe(true);
    expect(result.current.isToggling("b")).toBe(true);

    await act(async () => {
      finishA(success);
      await doneA;
    });
    expect(result.current.isToggling("a")).toBe(false);
    expect(result.current.isToggling("b")).toBe(true);
    // B's flip survives A's write landing.
    expect(result.current.apply(rows)[1].enabled).toBe(true);

    await act(async () => {
      finishB(success);
      await doneB;
    });
    expect(result.current.isToggling("b")).toBe(false);
  });
});
