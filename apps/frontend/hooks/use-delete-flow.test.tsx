import { describe, it, expect, vi } from "vitest";
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

function setup<TResult = unknown>(
  outcome: WriteOutcome<TResult>,
  options: { guidanceOnForbidden?: boolean } = {},
) {
  const perform = vi.fn().mockResolvedValue(outcome);
  const mutate = vi.fn();
  const onSuccess = vi.fn();
  const { result } = renderHook(() =>
    useDeleteFlow<Target, TResult>({
      delete: perform,
      mutate,
      onSuccess,
      ...options,
    }),
  );
  return { result, perform, mutate, onSuccess };
}

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
    expect(onSuccess).toHaveBeenCalledWith(target, null);
    expect(result.current.open).toBe(false);
    expect(result.current.target).toBeNull();
  });

  it("passes the successful response's data to onSuccess", async () => {
    const { result, onSuccess } = setup<{ token: string }>({
      outcome: "success",
      data: { token: "pit_regenerated" },
      revalidateKeys: [],
    });

    act(() => result.current.request(target));
    await act(async () => result.current.confirm());

    expect(onSuccess).toHaveBeenCalledWith(target, {
      token: "pit_regenerated",
    });
  });

  it("sends one write when confirm is pressed twice in flight", async () => {
    let release: (outcome: WriteOutcome<unknown>) => void = () => {};
    const perform = vi.fn(
      () =>
        new Promise<WriteOutcome<unknown>>((resolve) => {
          release = resolve;
        }),
    );
    const { result } = renderHook(() =>
      useDeleteFlow<Target>({ delete: perform, mutate: vi.fn() }),
    );

    act(() => result.current.request(target));
    act(() => {
      void result.current.confirm();
      void result.current.confirm();
    });

    expect(perform).toHaveBeenCalledTimes(1);
    expect(result.current.dialogProps.loading).toBe(true);

    await act(async () => {
      release({ outcome: "success", data: null, revalidateKeys: [] });
    });
    expect(result.current.dialogProps.loading).toBe(false);
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

  it("shows a validation refusal inline rather than swallowing it", async () => {
    const { result, mutate } = setup({
      outcome: "invalid",
      message: "A new token can't be issued yet",
      fieldErrors: { tokenExpiryDays: "Pick a lifetime" },
    });

    act(() => result.current.request(target));
    await act(async () => result.current.confirm());

    expect(result.current.error).toBe("A new token can't be issued yet");
    expect(result.current.open).toBe(true);
    expect(mutate).not.toHaveBeenCalled();
  });

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

describe("useDeleteFlow dialogProps", () => {
  it("wires the confirm dialog's open state, loading and error", async () => {
    const { result, perform } = setup({
      outcome: "success",
      data: null,
      revalidateKeys: [],
    });

    expect(result.current.dialogProps).toMatchObject({
      open: false,
      loading: false,
      error: null,
    });

    act(() => result.current.request(target));
    expect(result.current.dialogProps.open).toBe(true);

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = Promise.resolve(result.current.dialogProps.onConfirm());
    });
    expect(result.current.dialogProps.loading).toBe(true);
    await act(async () => {
      await pending;
    });
    expect(perform).toHaveBeenCalledWith(target, "http://test");
    expect(result.current.dialogProps.loading).toBe(false);
    expect(result.current.dialogProps.open).toBe(false);
  });

  it("closes on a dismissed dialog and holds an open one", () => {
    const { result } = setup({
      outcome: "success",
      data: null,
      revalidateKeys: [],
    });

    act(() => result.current.request(target));
    act(() => result.current.dialogProps.onOpenChange(true));
    expect(result.current.open).toBe(true);

    act(() => result.current.dialogProps.onOpenChange(false));
    expect(result.current.open).toBe(false);
  });

  it("shows the refusal inline and clears it when the dialog closes", async () => {
    const { result } = setup({ outcome: "conflict", message: "In use" });

    act(() => result.current.request(target));
    await act(async () => result.current.dialogProps.onConfirm());

    expect(result.current.dialogProps.error).toBe("In use");
    expect(result.current.dialogProps.open).toBe(true);

    act(() => result.current.dialogProps.onOpenChange(false));
    expect(result.current.dialogProps.error).toBeNull();
  });
});
