import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { WriteOutcome } from "@/lib/api-write";

vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://test",
}));

const { toastInfoSpy, toastErrorSpy } = vi.hoisted(() => ({
  toastInfoSpy: vi.fn(),
  toastErrorSpy: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { info: toastInfoSpy, error: toastErrorSpy },
}));

import { useDeleteFlow } from "./use-delete-flow";

type Target = { id: string; name: string };

const target: Target = { id: "a1", name: "Shared Agent" };

function setup(
  outcome: WriteOutcome<unknown>,
  options: { guidanceOnForbidden?: boolean } = {},
) {
  const perform = vi.fn().mockResolvedValue(outcome);
  const mutate = vi.fn();
  const onSuccess = vi.fn();
  const { result } = renderHook(() =>
    useDeleteFlow<Target>({ delete: perform, mutate, onSuccess, ...options }),
  );
  return { result, perform, mutate, onSuccess };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("useDeleteFlow", () => {
  it("starts closed with no error", () => {
    const { result } = setup({
      outcome: "success",
      data: null,
      revalidateKeys: [],
    });

    expect(result.current.target).toBeNull();
    expect(result.current.open).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.deleting).toBe(false);
  });

  it("opens on request and clears the last refusal's error", async () => {
    const { result } = setup({ outcome: "conflict", message: "In use" });
    act(() => result.current.request(target));
    await act(async () => result.current.confirm());
    expect(result.current.error).toBe("In use");

    const other = { id: "a2", name: "Other Agent" };
    act(() => result.current.request(other));

    expect(result.current.open).toBe(true);
    expect(result.current.target).toEqual(other);
    expect(result.current.error).toBeNull();
  });

  it("deletes, revalidates, closes, and reports success", async () => {
    const { result, perform, mutate, onSuccess } = setup({
      outcome: "success",
      data: null,
      revalidateKeys: ["/agents"],
    });

    act(() => result.current.request(target));
    await act(async () => result.current.confirm());

    expect(perform).toHaveBeenCalledWith(target, "http://test");
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith(target);
    expect(result.current.open).toBe(false);
    expect(result.current.target).toBeNull();
  });

  it.each(["conflict", "notFound", "error"] as const)(
    "shows a %s refusal inline, keeps the dialog open, and does not revalidate",
    async (outcome) => {
      const { result, mutate } = setup({ outcome, message: "Agent is in use" });

      act(() => result.current.request(target));
      await act(async () => result.current.confirm());

      expect(result.current.error).toBe("Agent is in use");
      expect(result.current.open).toBe(true);
      expect(mutate).not.toHaveBeenCalled();
    },
  );

  it("keeps a forbidden refusal inline by default", async () => {
    const { result, mutate } = setup({
      outcome: "forbidden",
      message: "You do not have permission to do this.",
    });

    act(() => result.current.request(target));
    await act(async () => result.current.confirm());

    expect(result.current.error).toBe("You do not have permission to do this.");
    expect(result.current.open).toBe(true);
    expect(toastInfoSpy).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("treats a forbidden refusal as guidance when the list opts in", async () => {
    const { result, mutate } = setup(
      {
        outcome: "forbidden",
        message: "This agent is managed at the organization level",
      },
      { guidanceOnForbidden: true },
    );

    act(() => result.current.request(target));
    await act(async () => result.current.confirm());

    expect(toastInfoSpy).toHaveBeenCalledWith(
      "This agent is managed at the organization level",
    );
    expect(toastErrorSpy).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
    expect(result.current.open).toBe(false);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("closes without deleting on close", () => {
    const { result, perform } = setup({
      outcome: "success",
      data: null,
      revalidateKeys: [],
    });

    act(() => result.current.request(target));
    act(() => result.current.close());

    expect(result.current.open).toBe(false);
    expect(perform).not.toHaveBeenCalled();
  });
});
