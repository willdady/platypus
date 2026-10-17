import { describe, it, expect, vi, beforeEach } from "vitest";
import { useState } from "react";
import { act, renderHook } from "@testing-library/react";
import {
  authMock,
  swrMock,
  configuredMutate,
  toastSuccess,
  toastError,
  toastInfo,
  resetFormHarness,
  setData,
  setDataFor,
  setError,
  setLoading,
  stubAcceptedSave,
  stubRejectedSave,
} from "@/test/form-test-harness";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("swr", () => swrMock);

import { useEntityDelete, useEntityForm } from "./use-entity-form";

type Data = { name: string; description: string };

const baseOptions = {
  initialData: { name: "", description: "" },
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

  it("is clean once seeded, dirty after an edit, and clean again once reverted", () => {
    setData(row);
    const { result } = renderRead({});
    expect(result.current.isDirty).toBe(false);

    act(() => result.current.setField("name", "Edited"));
    expect(result.current.isDirty).toBe(true);

    act(() => result.current.setField("name", "Deploy"));
    expect(result.current.isDirty).toBe(false);
  });

  it("tracks sideState against what onSeed set", () => {
    setData(row);
    const { result } = renderHook(() => {
      const [tags, setTags] = useState<string[]>([]);
      const form = useEntityForm<Data, unknown, Row>({
        ...baseOptions,
        id: "s1",
        fromRecord,
        sideState: tags,
        onSeed: () => setTags(["seeded"]),
      });
      return { form, setTags };
    });
    expect(result.current.form.isDirty).toBe(false);

    act(() => result.current.setTags(["seeded", "added"]));
    expect(result.current.form.isDirty).toBe(true);

    act(() => result.current.setTags(["seeded"]));
    expect(result.current.form.isDirty).toBe(false);
  });

  it("is clean after seedFormData, a change the form makes itself", () => {
    const { result } = renderHook(() =>
      useEntityForm<Data, unknown>(baseOptions),
    );
    act(() =>
      result.current.seedFormData((prev) => ({ ...prev, name: "Default" })),
    );
    expect(result.current.formData.name).toBe("Default");
    expect(result.current.isDirty).toBe(false);
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

  it("toasts a default failure when the save throws", async () => {
    stubAcceptedSave({ id: "s1" });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { result } = renderHook(() =>
      useEntityForm<Data, unknown>({
        ...baseOptions,
        onSuccess: () => {
          throw new Error("boom");
        },
      }),
    );

    await act(async () => {
      await result.current.submit();
    });

    expect(toastError).toHaveBeenCalledWith("Couldn't save");
    expect(result.current.isSubmitting).toBe(false);
  });
});

describe("useEntityForm dirty across a save", () => {
  beforeEach(() => resetFormHarness());

  it("is clean after a successful save", async () => {
    stubAcceptedSave({ id: "s1" });
    const { result } = renderHook(() =>
      useEntityForm<Data, { id: string }>(baseOptions),
    );

    act(() => result.current.setField("name", "Deploy"));
    await act(async () => {
      await result.current.submit();
    });

    expect(result.current.isDirty).toBe(false);
  });

  it("stays dirty after a failed save", async () => {
    stubRejectedSave([{ path: ["name"], message: "Name is taken" }], 400);
    const { result } = renderHook(() =>
      useEntityForm<Data, unknown>(baseOptions),
    );

    act(() => result.current.setField("name", "Deploy"));
    await act(async () => {
      await result.current.submit();
    });

    expect(result.current.isDirty).toBe(true);
  });
});

describe("useEntityDelete lifecycle", () => {
  beforeEach(() => resetFormHarness());

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

  // A form that stays mounted after deleting (the Sandbox) can delete again.
  it("reopens the dialog idle after a successful delete", async () => {
    stubAcceptedSave({});

    const { result } = renderDelete();
    await act(async () => {
      await result.current.handleDelete();
    });
    expect(result.current.isDeleting).toBe(true);

    act(() => result.current.openDeleteDialog());
    expect(result.current.isDeleting).toBe(false);
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

  it("keeps a forbidden delete inline by default", async () => {
    stubRejectedSave("Managed elsewhere", 403);

    const { result } = renderDelete();
    act(() => result.current.openDeleteDialog());
    await act(async () => {
      await result.current.handleDelete();
    });

    expect(result.current.isDeleteDialogOpen).toBe(true);
    expect(result.current.deleteError).toBe("Managed elsewhere");
    expect(result.current.isDeleting).toBe(false);
    expect(toastInfo).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("closes a forbidden delete with a guidance toast when opted in", async () => {
    stubRejectedSave("Managed elsewhere", 403);

    const { result } = renderDelete({ guidanceOnForbidden: true });
    act(() => result.current.openDeleteDialog());
    await act(async () => {
      await result.current.handleDelete();
    });

    expect(toastInfo).toHaveBeenCalledWith("Managed elsewhere");
    expect(toastError).not.toHaveBeenCalled();
    expect(result.current.isDeleteDialogOpen).toBe(false);
    expect(result.current.deleteError).toBeNull();
    expect(result.current.isDeleting).toBe(false);
  });

  it("keeps any other refusal inline even when opted in", async () => {
    stubRejectedSave("Still referenced", 409);

    const { result } = renderDelete({ guidanceOnForbidden: true });
    act(() => result.current.openDeleteDialog());
    await act(async () => {
      await result.current.handleDelete();
    });

    expect(result.current.isDeleteDialogOpen).toBe(true);
    expect(result.current.deleteError).toBe("Still referenced");
    expect(toastInfo).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("lets onError claim a refusal, falling back to inline when it doesn't", async () => {
    stubRejectedSave("Still referenced", 409);
    const onError = vi
      .fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    const { result } = renderHook(() =>
      useEntityDelete({
        entity: "skills",
        scope: { orgId: "org1" },
        id: "s1",
        onError,
      }),
    );
    await act(async () => {
      await result.current.handleDelete();
    });
    expect(onError).toHaveBeenCalledWith(
      "Still referenced",
      expect.objectContaining({ outcome: "conflict" }),
    );
    expect(result.current.deleteError).toBeNull();
    expect(result.current.isDeleting).toBe(false);

    await act(async () => {
      await result.current.handleDelete();
    });
    expect(result.current.deleteError).toBe("Still referenced");
  });

  it("clears the pending flag and stays inline when the delete throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = renderHook(() =>
      useEntityDelete({
        entity: "skills",
        scope: { orgId: "org1" },
        id: "s1",
        write: () => Promise.reject(new Error("boom")),
      }),
    );

    await act(async () => {
      await result.current.handleDelete();
    });

    expect(result.current.isDeleting).toBe(false);
    expect(result.current.deleteError).toBe("Couldn't delete");
  });
});

function renderDelete(options: { guidanceOnForbidden?: boolean } = {}) {
  return renderHook(() =>
    useEntityDelete({
      entity: "skills",
      scope: { orgId: "org1" },
      id: "s1",
      ...options,
    }),
  );
}
