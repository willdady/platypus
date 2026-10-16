import { describe, it, expect, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ cookie: "better-auth.session_token=abc" }),
}));

import { generateMetadata as agentMetadata } from "./[orgId]/workspace/[workspaceId]/agents/[agentId]/page";
import { generateMetadata as triggerMetadata } from "./[orgId]/workspace/[workspaceId]/triggers/[triggerId]/page";

import { generateMetadata as orgHomeMetadata } from "./[orgId]/(home)/page";

const pages = [
  {
    name: "Organization home",
    metadata: () =>
      orgHomeMetadata({ params: Promise.resolve({ orgId: "org1" }) }),
    path: "/organizations/org1",
    fallback: "Organization",
  },
  {
    name: "Agent",
    metadata: () =>
      agentMetadata({
        params: Promise.resolve({
          orgId: "org1",
          workspaceId: "ws1",
          agentId: "agent1",
        }),
      }),
    path: "/organizations/org1/workspaces/ws1/agents/agent1",
    fallback: "Edit Agent",
  },
  {
    name: "Trigger",
    metadata: () =>
      triggerMetadata({
        params: Promise.resolve({
          orgId: "org1",
          workspaceId: "ws1",
          triggerId: "trigger1",
        }),
      }),
    path: "/organizations/org1/workspaces/ws1/triggers/trigger1",
    fallback: "Edit Trigger",
  },
];

describe.each(pages)(
  "$name edit page title",
  ({ metadata, path, fallback }) => {
    it("is the entity's name, read as the signed-in user", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(JSON.stringify({ id: "x", name: "Nightly digest" }), {
            status: 200,
          }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await expect(metadata()).resolves.toEqual({ title: "Nightly digest" });
      expect(fetchMock).toHaveBeenCalledWith(
        `http://localhost:4001${path}`,
        expect.objectContaining({
          headers: { cookie: "better-auth.session_token=abc" },
        }),
      );
    });

    it("falls back to the page's heading when the read is refused", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("{}", { status: 401 })),
      );

      await expect(metadata()).resolves.toEqual({ title: fallback });
    });

    it("falls back to the page's heading when the backend is unreachable", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new TypeError("fetch failed");
        }),
      );

      await expect(metadata()).resolves.toEqual({ title: fallback });
    });
  },
);
