import { describe, it, expect, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useMutation } from "./use-mutation";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useMutation", () => {
  it("is pending while the action runs, and idle once it settles", async () => {
    const call = deferred();
    const { result } = renderHook(() => useMutation(() => call.promise));

    expect(result.current.pending).toBe(false);
    let run!: Promise<unknown>;
    act(() => {
      run = result.current.run();
    });
    expect(result.current.pending).toBe(true);

    await act(async () => {
      call.resolve();
      await run;
    });
    expect(result.current.pending).toBe(false);
  });

  it("drops a second run while the first is in flight", async () => {
    const call = deferred();
    const fn = vi.fn(() => call.promise);
    const { result } = renderHook(() => useMutation(fn));

    act(() => {
      void result.current.run();
      void result.current.run();
    });
    expect(fn).toHaveBeenCalledOnce();

    await act(async () => call.resolve());
  });

  it("runs again once the first has settled", async () => {
    const fn = vi.fn<(n: number) => Promise<void>>(async () => {});
    const { result } = renderHook(() => useMutation(fn));

    await act(() => result.current.run(1));
    await act(() => result.current.run(2));

    expect(fn.mock.calls).toEqual([[1], [2]]);
  });

  it("clears pending when the action throws, and passes the error on", async () => {
    const call = deferred();
    const { result } = renderHook(() => useMutation(() => call.promise));

    let run!: Promise<unknown>;
    act(() => {
      run = result.current.run();
    });
    await act(async () => {
      call.reject(new Error("boom"));
      await expect(run).rejects.toThrow("boom");
    });
    expect(result.current.pending).toBe(false);
  });
});
