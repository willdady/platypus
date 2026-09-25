// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";
import { toast } from "sonner";
import {
  applyWriteOutcome,
  applyDeleteOutcome,
  toastGuidanceOrError,
} from "./apply-write-outcome";
import type { WriteOutcome } from "./api-write";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

describe("applyWriteOutcome", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("revalidates every key and calls onSuccess with the data on success", async () => {
    const mutate = vi.fn();
    const onSuccess = vi.fn();
    const result: WriteOutcome<{ id: string }> = {
      outcome: "success",
      data: { id: "a1" },
      revalidateKeys: ["/a", "/b"],
    };

    await applyWriteOutcome(result, {
      mutate,
      setValidationErrors: vi.fn(),
      onSuccess,
    });

    expect(mutate).toHaveBeenCalledWith("/a");
    expect(mutate).toHaveBeenCalledWith("/b");
    expect(onSuccess).toHaveBeenCalledWith({ id: "a1" });
  });

  it("awaits an async onSuccess before returning", async () => {
    const order: string[] = [];
    const onSuccess = vi.fn(async () => {
      order.push("start");
      await Promise.resolve();
      order.push("end");
    });

    await applyWriteOutcome(
      { outcome: "success", data: null, revalidateKeys: [] },
      { mutate: vi.fn(), setValidationErrors: vi.fn(), onSuccess },
    );
    order.push("after");

    expect(order).toEqual(["start", "end", "after"]);
  });

  it("sets field errors on invalid and does not toast when field errors exist", async () => {
    const setValidationErrors = vi.fn();

    await applyWriteOutcome(
      {
        outcome: "invalid",
        message: "Validation failed",
        fieldErrors: { name: "Required" },
      },
      { mutate: vi.fn(), setValidationErrors },
    );

    expect(setValidationErrors).toHaveBeenCalledWith({ name: "Required" });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("toasts the shared copy when invalidMessage is given and a field was rejected", async () => {
    await applyWriteOutcome(
      {
        outcome: "invalid",
        message: "Validation failed",
        fieldErrors: { name: "Required" },
      },
      {
        mutate: vi.fn(),
        setValidationErrors: vi.fn(),
        invalidMessage: "Please fix the errors in the form",
      },
    );

    expect(toast.error).toHaveBeenCalledWith(
      "Please fix the errors in the form",
    );
  });

  it("falls back to onError when invalid carries no field errors", async () => {
    const setValidationErrors = vi.fn();

    await applyWriteOutcome(
      { outcome: "invalid", message: "Bad request", fieldErrors: {} },
      { mutate: vi.fn(), setValidationErrors },
    );

    expect(setValidationErrors).toHaveBeenCalledWith({});
    expect(toast.error).toHaveBeenCalledWith("Bad request");
  });

  it("lets onInvalid fully override the default invalid handling", async () => {
    const onInvalid = vi.fn();
    const setValidationErrors = vi.fn();

    await applyWriteOutcome(
      {
        outcome: "invalid",
        message: "Bad request",
        fieldErrors: { name: "Required" },
      },
      { mutate: vi.fn(), setValidationErrors, onInvalid },
    );

    expect(onInvalid).toHaveBeenCalledWith({ name: "Required" }, "Bad request");
    expect(setValidationErrors).not.toHaveBeenCalled();
  });

  it("keys a conflict's message to the default 'name' field", async () => {
    const setValidationErrors = vi.fn();

    await applyWriteOutcome(
      { outcome: "conflict", message: "Already exists" },
      { mutate: vi.fn(), setValidationErrors },
    );

    expect(setValidationErrors).toHaveBeenCalledWith({
      name: "Already exists",
    });
  });

  it("keys a conflict's message to a custom field", async () => {
    const setValidationErrors = vi.fn();

    await applyWriteOutcome(
      { outcome: "conflict", message: "Already exists" },
      { mutate: vi.fn(), setValidationErrors, conflictField: "email" },
    );

    expect(setValidationErrors).toHaveBeenCalledWith({
      email: "Already exists",
    });
  });

  it("routes a conflict through onError when there's no field to key it to", async () => {
    const onError = vi.fn();

    await applyWriteOutcome(
      { outcome: "conflict", message: "Agent is in use" },
      {
        mutate: vi.fn(),
        setValidationErrors: vi.fn(),
        conflictField: null,
        onError,
      },
    );

    expect(onError).toHaveBeenCalledWith("Agent is in use", {
      outcome: "conflict",
      message: "Agent is in use",
    });
  });

  it("lets onConflict fully override the default conflict handling", async () => {
    const onConflict = vi.fn();
    const setValidationErrors = vi.fn();

    await applyWriteOutcome(
      { outcome: "conflict", message: "Already exists" },
      { mutate: vi.fn(), setValidationErrors, onConflict },
    );

    expect(onConflict).toHaveBeenCalledWith("Already exists");
    expect(setValidationErrors).not.toHaveBeenCalled();
  });

  it.each(["forbidden", "notFound", "error"] as const)(
    "toasts the message by default for a %s outcome",
    async (outcome) => {
      await applyWriteOutcome(
        { outcome, message: "Nope" },
        { mutate: vi.fn(), setValidationErrors: vi.fn() },
      );

      expect(toast.error).toHaveBeenCalledWith("Nope");
    },
  );

  it("passes the full outcome to onError so a caller can special-case forbidden", async () => {
    const onError = vi.fn();

    await applyWriteOutcome(
      { outcome: "forbidden", message: "Locked" },
      { mutate: vi.fn(), setValidationErrors: vi.fn(), onError },
    );

    expect(onError).toHaveBeenCalledWith("Locked", {
      outcome: "forbidden",
      message: "Locked",
    });
  });
});

describe("applyDeleteOutcome", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("revalidates and calls onSuccess on success", async () => {
    const mutate = vi.fn();
    const onSuccess = vi.fn();

    await applyDeleteOutcome(
      { outcome: "success", data: null, revalidateKeys: ["/a"] },
      { mutate, onSuccess },
    );

    expect(mutate).toHaveBeenCalledWith("/a");
    expect(onSuccess).toHaveBeenCalledWith(null);
  });

  it("routes a conflict (e.g. still referenced) through onError, with no field to key it to", async () => {
    const onError = vi.fn();

    await applyDeleteOutcome(
      { outcome: "conflict", message: "Agent is in use" },
      { mutate: vi.fn(), onError },
    );

    expect(onError).toHaveBeenCalledWith("Agent is in use", {
      outcome: "conflict",
      message: "Agent is in use",
    });
  });

  it.each(["forbidden", "notFound", "error"] as const)(
    "routes a %s outcome through onError",
    async (outcome) => {
      const onError = vi.fn();

      await applyDeleteOutcome(
        { outcome, message: "Nope" },
        { mutate: vi.fn(), onError },
      );

      expect(onError).toHaveBeenCalledWith("Nope", {
        outcome,
        message: "Nope",
      });
    },
  );
});

describe("toastGuidanceOrError", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows an info toast for a forbidden outcome", () => {
    toastGuidanceOrError("Managed at the organization level", {
      outcome: "forbidden",
      message: "Managed at the organization level",
    });

    expect(toast.info).toHaveBeenCalledWith(
      "Managed at the organization level",
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it.each(["notFound", "error"] as const)(
    "shows an error toast for a %s outcome",
    (outcome) => {
      toastGuidanceOrError("Nope", { outcome, message: "Nope" });

      expect(toast.error).toHaveBeenCalledWith("Nope");
      expect(toast.info).not.toHaveBeenCalled();
    },
  );
});
