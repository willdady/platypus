import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { notFound } = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("next/navigation", () => ({ notFound }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ cookie: "session=1" }),
}));

import WorkspaceLayout from "./layout";

const renderLayout = () =>
  WorkspaceLayout({
    children: null,
    params: Promise.resolve({ orgId: "org1", workspaceId: "ws1" }),
  });

const stubWorkspaceRead = (status: number) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      status === 200
        ? new Response(JSON.stringify({ id: "ws1", name: "Research" }), {
            status,
          })
        : new Response("{}", { status }),
    ),
  );

beforeEach(() => {
  notFound.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe("WorkspaceLayout", () => {
  it("renders the Workspace it read", async () => {
    stubWorkspaceRead(200);

    await expect(renderLayout()).resolves.toBeTruthy();
  });

  it("sends a missing Workspace to not found", async () => {
    stubWorkspaceRead(404);

    await expect(renderLayout()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  // Thrown to the error boundary, which offers to try again, rather than
  // rendering the Workspace's pages over a read that failed.
  it("fails a Workspace read that errored server-side instead of rendering", async () => {
    stubWorkspaceRead(500);

    await expect(renderLayout()).rejects.toThrow();
    expect(notFound).not.toHaveBeenCalled();
  });

  // Access is the client gate's call, which can say why.
  it("leaves a forbidden Workspace to the access gate", async () => {
    stubWorkspaceRead(403);

    await expect(renderLayout()).resolves.toBeTruthy();
  });
});
