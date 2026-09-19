import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  authMock,
  toastMock,
  swrMock,
  configuredMutate,
  toastSuccess,
  resetFormHarness,
  stubAcceptedSave,
  stubRejectedSave,
} from "@/lib/form-test-harness";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("sonner", () => toastMock);
vi.mock("swr", () => swrMock);

import { useEntityDelete, useEntityForm } from "./use-entity-form";

type Data = { name: string; description: string };

const baseOptions = {
  initialData: { name: "", description: "" } as Data,
  entity: "skills",
  scope: { orgId: "org1" },
  retractableFields: ["name", "description"],
  buildPayload: (data: Data) => data,
};

describe("useEntityForm field adapters", () => {
  it("sets a field and retracts an error keyed to it or a path under it", () => {
    const { result } = renderHook(() =>
      useEntityForm<Data, unknown>(baseOptions),
    );

    act(() =>
      result.current.setValidationErrors({
        name: "too short",
        "name.first": "row error",
        description: "too long",
      }),
    );

    act(() => result.current.setField("name", "Fine"));

    expect(result.current.formData.name).toBe("Fine");
    expect(result.current.validationErrors).toEqual({
      description: "too long",
    });
  });

  it("gates Save only on errors keyed to a retractable field", () => {
    const { result } = renderHook(() =>
      useEntityForm<Data, unknown>(baseOptions),
    );

    act(() => result.current.setValidationErrors({ name: "bad" }));
    expect(result.current.canSubmit).toBe(false);

    act(() => result.current.setValidationErrors({ toolSetIds: "bad" }));
    expect(result.current.canSubmit).toBe(true);
  });

  it("sets numeric and float fields, clearing to undefined when emptied", () => {
    type Numbers = { count?: number; ratio?: number };
    const { result } = renderHook(() =>
      useEntityForm<Numbers, unknown>({
        initialData: {},
        entity: "skills",
        scope: { orgId: "org1" },
        retractableFields: [],
      }),
    );

    act(() => result.current.setNumberField("count", "12"));
    expect(result.current.formData.count).toBe(12);

    act(() => result.current.setFloatField("ratio", "0.5"));
    expect(result.current.formData.ratio).toBe(0.5);

    act(() => result.current.setNumberField("count", ""));
    expect(result.current.formData.count).toBeUndefined();
  });
});

describe("useEntityForm submit lifecycle", () => {
  beforeEach(() => resetFormHarness());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("writes, revalidates, toasts and hands the saved record on", async () => {
    const fetchMock = stubAcceptedSave({ id: "s1" });
    const onSuccess = vi.fn();

    const { result } = renderHook(() =>
      useEntityForm<Data, { id: string }>({
        ...baseOptions,
        successMessage: "Skill saved",
        onSuccess,
      }),
    );

    act(() => result.current.setField("name", "Deploy"));

    let saved: { id: string } | undefined;
    await act(async () => {
      saved = await result.current.submit();
    });

    expect(saved).toEqual({ id: "s1" });
    expect(onSuccess).toHaveBeenCalledWith({ id: "s1" });
    expect(toastSuccess).toHaveBeenCalledWith("Skill saved");
    expect(configuredMutate).toHaveBeenCalledWith(
      "http://test/organizations/org1/skills",
    );
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://test/organizations/org1/skills");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      name: "Deploy",
      description: "",
    });
  });

  it("surfaces a rejected field inline and never calls onSuccess", async () => {
    stubRejectedSave([{ path: ["name"], message: "Name is taken" }], 400);
    const onSuccess = vi.fn();

    const { result } = renderHook(() =>
      useEntityForm<Data, unknown>({ ...baseOptions, onSuccess }),
    );

    await act(async () => {
      await result.current.submit();
    });

    expect(result.current.validationErrors.name).toBe("Name is taken");
    expect(onSuccess).not.toHaveBeenCalled();
  });
});

describe("useEntityDelete lifecycle", () => {
  beforeEach(() => resetFormHarness());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("deletes, revalidates and hands off on success", async () => {
    const fetchMock = stubAcceptedSave({});
    const onSuccess = vi.fn();

    const { result } = renderHook(() =>
      useEntityDelete({
        entity: "skills",
        scope: { orgId: "org1" },
        id: "s1",
        successMessage: "Skill deleted",
        onSuccess,
      }),
    );

    await act(async () => {
      await result.current.handleDelete();
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://test/organizations/org1/skills/s1",
    );
    expect(onSuccess).toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledWith("Skill deleted");
    expect(configuredMutate).toHaveBeenCalledWith(
      "http://test/organizations/org1/skills",
    );
  });

  it("keeps a failed delete in the dialog with the backend's message", async () => {
    stubRejectedSave("Still referenced", 409);

    const { result } = renderHook(() =>
      useEntityDelete({
        entity: "skills",
        scope: { orgId: "org1" },
        id: "s1",
      }),
    );

    await act(async () => {
      await result.current.handleDelete();
    });

    expect(result.current.deleteError).toBe("Still referenced");
    expect(result.current.isDeleting).toBe(false);
  });

  it("lets a caller close the dialog on a forbidden delete", async () => {
    stubRejectedSave("Managed elsewhere", 403);
    let closed = false;

    const { result } = renderHook(() =>
      useEntityDelete({
        entity: "skills",
        scope: { orgId: "org1" },
        id: "s1",
        onError: (_message, _outcome, controls) => {
          controls.close();
          closed = true;
        },
      }),
    );

    act(() => result.current.openDeleteDialog());

    await act(async () => {
      await result.current.handleDelete();
    });

    expect(closed).toBe(true);
    expect(result.current.isDeleteDialogOpen).toBe(false);
    expect(result.current.deleteError).toBeNull();
  });
});
