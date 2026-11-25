import type { Metadata } from "next";
import { describe, it, expect, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ cookie: "better-auth.session_token=abc" }),
}));

import * as agentPage from "./[orgId]/workspace/[workspaceId]/(plain)/agents/[agentId]/page";
import * as triggerPage from "./[orgId]/workspace/[workspaceId]/(plain)/triggers/[triggerId]/page";

import { generateMetadata as orgHomeMetadata } from "./[orgId]/(home)/page";

const editPages: Array<{ name: string; metadata: Metadata; title: string }> = [
  { name: "Agent", metadata: agentPage.metadata, title: "Edit Agent" },
  { name: "Trigger", metadata: triggerPage.metadata, title: "Edit Trigger" },
];

describe.each(editPages)("$name edit page title", ({ metadata, title }) => {
  it("is a fixed string for the page type", () => {
    expect(metadata).toEqual({ title });
  });
});

describe("Organization home title", () => {
  const metadata = () =>
    orgHomeMetadata({ params: Promise.resolve({ orgId: "org1" }) });

  it("is the organization's name, read as the signed-in user", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "x", name: "Acme Corp" }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(metadata()).resolves.toEqual({ title: "Acme Corp" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4001/organizations/org1",
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

    await expect(metadata()).resolves.toEqual({ title: "Organization" });
  });

  it("falls back to the page's heading when the backend is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    await expect(metadata()).resolves.toEqual({ title: "Organization" });
  });
});
