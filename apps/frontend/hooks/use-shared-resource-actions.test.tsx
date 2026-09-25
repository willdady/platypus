import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { jsonResponse, stubAcceptedSave } from "@/lib/test-utils";

vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://test",
}));

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

  // The backend still refuses a delete of an attached resource with a 409, so
  // a failed check must not strand the user without a Delete at all.
  it("hands the row to the delete flow when the attachment check fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("down")));
    const { result, onAllowed } = renderGuard();

    await act(async () => result.current.request(skill));

    expect(onAllowed).toHaveBeenCalledWith(skill);
    expect(result.current.blocked).toBeNull();
  });

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
