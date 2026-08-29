import { describe, it, expect, vi } from "vitest";

const { redirectSpy } = vi.hoisted(() => ({ redirectSpy: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: redirectSpy }));

import TriggerRunsRedirect from "./page";

// The per-trigger runs page is gone, but links and bookmarks to it are not.
describe("Per-trigger runs redirect", () => {
  it("sends an old link to the consolidated page with its trigger pre-selected", async () => {
    await TriggerRunsRedirect({
      params: Promise.resolve({
        orgId: "org-1",
        workspaceId: "ws-1",
        triggerId: "trigger-1",
      }),
    });

    expect(redirectSpy).toHaveBeenCalledWith(
      "/org-1/workspace/ws-1/trigger-runs?triggerId=trigger-1",
    );
  });
});
