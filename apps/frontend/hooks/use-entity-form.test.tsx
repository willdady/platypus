import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  authMock,
  toastMock,
  swrMock,
  configuredMutate,
  toastSuccess,
  resetFormHarness,
  setData,
  setDataFor,
  setError,
  setLoading,
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

describe("useEntityForm record read", () => {
  beforeEach(() => resetFormHarness());

  type Row = { id: string; name: string; description: string };
  const row: Row = { id: "s1", name: "Deploy", description: "Ships it" };
  const fromRecord = (r: Row): Data => ({
    name: r.name,
    description: r.description,
  });

  const renderRead = (
    options: Partial<Parameters<typeof useEntityForm<Data, unknown, Row>>[0]>,
  ) =>
    renderHook(
      (props: { id?: string }) =>
        useEntityForm<Data, unknown, Row>({
          ...baseOptions,
          id: "s1",
          fromRecord,
          ...options,
          ...props,
        }),
      { initialProps: {} },
    );

  it("reads the record at the Organization scope", () => {
    setDataFor("/organizations/org1/skills/s1", row);
    const { result } = renderRead({});
    expect(result.current.record).toBe(row);
  });

  it("reads the record at the Workspace scope", () => {
    setDataFor("/organizations/org1/workspaces/ws1/skills/s1", row);
    const { result } = renderRead({
      scope: { orgId: "org1", workspaceId: "ws1" },
    });
    expect(result.current.record).toBe(row);
  });

  it("reads a user-scoped record from the root scope", () => {
    setDataFor("http://test/users/me/contexts/s1", row);
    const { result } = renderRead({ entity: "users/me/contexts", scope: {} });
    expect(result.current.record).toBe(row);
  });

  it("seeds formData from the record", () => {
    setData(row);
    const { result } = renderRead({});
    expect(result.current.formData).toEqual({
      name: "Deploy",
      description: "Ships it",
    });
  });

  it("keeps an edit when the same record changes on the server", () => {
    setData(row);
    const onSeed = vi.fn();
    const { result, rerender } = renderRead({ onSeed });

    act(() => result.current.setField("name", "Edited"));
    setData({ ...row, name: "server" });
    rerender({});

    expect(result.current.formData.name).toBe("Edited");
    expect(result.current.record?.name).toBe("server");
    expect(onSeed).toHaveBeenCalledTimes(1);
  });

  it("re-seeds for a different record id", () => {
    setData(row);
    const { result, rerender } = renderRead({});

    act(() => result.current.setField("name", "Edited"));
    setData({ id: "s2", name: "Other", description: "" });
    rerender({ id: "s2" });

    expect(result.current.formData.name).toBe("Other");
  });

  it("passes the read's state through for DetailFormState", () => {
    setLoading();
    const { result, rerender } = renderRead({});
    expect(result.current.loadState.isLoading).toBe(true);

    const failure = Object.assign(new Error("gone"), { status: 404 });
    resetFormHarness();
    setError(failure);
    rerender({});
    expect(result.current.loadState).toMatchObject({
      isLoading: false,
      error: failure,
      data: undefined,
    });

    resetFormHarness();
    setData(row);
    rerender({});
    expect(result.current.loadState.data).toBe(row);
  });

  it("issues no read and is not loading without an id", () => {
    setLoading();
    const { result } = renderRead({ id: undefined });
    expect(result.current.loadState).toEqual({
      isLoading: false,
      error: undefined,
      data: undefined,
    });
    expect(result.current.formData).toEqual(baseOptions.initialData);
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
