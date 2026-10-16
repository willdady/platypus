import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  jsonResponse,
  stubAcceptedSave,
  stubRejectedSave,
  toastError,
  toastMock,
} from "@/test/test-utils";

vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://test",
}));
vi.mock("sonner", () => toastMock);

import {
  usePromoteShared,
  useSharedDeleteGuard,
} from "./use-shared-resource-actions";

/**
 * The lists exercise the refusals (blockers, attachment counts) through their
 * own UI. These cover the hook paths no list test reaches: a Promote that
 * lands, and a delete guard whose own check fails.
 */

const skill = { id: "s1", name: "Deploy" };
const scope = { orgId: "org1", workspaceId: "ws1" };

afterEach(() => {
  vi.unstubAllGlobals();
  toastError.mockClear();
});

describe("usePromoteShared", () => {
  const renderPromote = () => {
    const mutate = vi.fn();
    const view = renderHook(() =>
      usePromoteShared<typeof skill>({ entity: "skills", scope, mutate }),
    );
    return { ...view, mutate };
  };

  it("promotes the open row, revalidates and closes", async () => {
    const fetchMock = stubAcceptedSave();
    const { result, mutate } = renderPromote();

    act(() => result.current.open(skill));
    await act(async () => result.current.confirm());

    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/skills/s1/promote",
      { method: "POST", credentials: "include" },
    );
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(result.current.selected).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.promoting).toBe(false);
  });

  it("keeps the dialog open and says so when the backend is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("down")));
    const { result, mutate } = renderPromote();

    act(() => result.current.open(skill));
    await act(async () => result.current.confirm());

    expect(result.current.error).toBe("Network request failed");
    expect(result.current.selected).toEqual(skill);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("clears a refusal's reason and blockers on close", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(422, {
          error: "Promote blocked",
          blockers: [{ type: "provider", id: "p1", name: "Private" }],
        }),
      ),
    );
    const { result } = renderPromote();

    act(() => result.current.open(skill));
    await act(async () => result.current.confirm());
    expect(result.current.blockers).toHaveLength(1);

    act(() => result.current.close());

    expect(result.current.selected).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.blockers).toEqual([]);
  });
});

describe("useSharedDeleteGuard", () => {
  const renderGuard = () => {
    const onAllowed = vi.fn();
    const view = renderHook(() =>
      useSharedDeleteGuard<typeof skill>({
        resourceType: "skill",
        scope: { orgId: "org1" },
        onAllowed,
      }),
    );
    return { ...view, onAllowed };
  };

  it("reads the resource's attachment list", async () => {
    const fetchMock = stubAcceptedSave({ results: [] });
    const { result, onAllowed } = renderGuard();

    await act(async () => result.current.request(skill));

    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/attachments?resourceType=skill&resourceId=s1",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(onAllowed).toHaveBeenCalledWith(skill);
  });

  // A refused or failed check says nothing about the attachments: reading it
  // as "none" would go to a delete the backend then refuses.
  it.each([
    ["is refused", () => stubRejectedSave("Forbidden", 403)],
    ["errors", () => stubRejectedSave("Internal error", 500)],
    [
      "can't reach the backend",
      () =>
        vi.stubGlobal(
          "fetch",
          vi.fn().mockRejectedValue(new TypeError("down")),
        ),
    ],
  ])(
    "says so, rather than offering the delete, when the check %s",
    async (_label, stub) => {
      stub();
      const { result, onAllowed } = renderGuard();

      await act(async () => result.current.request(skill));

      expect(onAllowed).not.toHaveBeenCalled();
      expect(result.current.blocked).toBeNull();
      expect(toastError).toHaveBeenCalledWith(
        expect.stringContaining("Couldn't check"),
      );
    },
  );

  it("clears a block once dismissed", async () => {
    stubAcceptedSave({ results: [{ id: "att1" }, { id: "att2" }] });
    const { result, onAllowed } = renderGuard();

    await act(async () => result.current.request(skill));
    expect(result.current.blocked).toEqual({ item: skill, count: 2 });
    expect(onAllowed).not.toHaveBeenCalled();

    act(() => result.current.clear());

    expect(result.current.blocked).toBeNull();
  });
});
