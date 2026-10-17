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

import WorkspaceLayout, { generateMetadata } from "./layout";
import { SERVER_READ_TIMEOUT_MS } from "@/lib/server-read";

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

afterEach(() => {
  vi.useRealTimers();
});

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
  it.each([500, 503, 429])(
    "fails a Workspace read that answered %i instead of rendering",
    async (status) => {
      stubWorkspaceRead(status);

      await expect(renderLayout()).rejects.toThrow();
      expect(notFound).not.toHaveBeenCalled();
    },
  );

  it("fails a Workspace read the backend never answers once it times out", async () => {
    vi.useFakeTimers();
    // A fetch that only settles when its request is aborted.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) =>
            init.signal?.addEventListener("abort", () =>
              reject(init.signal?.reason),
            ),
          ),
      ),
    );

    await Promise.all([
      expect(renderLayout()).rejects.toThrow("unreachable"),
      vi.advanceTimersByTimeAsync(SERVER_READ_TIMEOUT_MS),
    ]);
  });

  it("encodes route ids so they can't change the backend path", async () => {
    stubWorkspaceRead(200);

    await WorkspaceLayout({
      children: null,
      params: Promise.resolve({ orgId: "org1", workspaceId: "a/b?c" }),
    });

    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/organizations\/org1\/workspaces\/a%2Fb%3Fc$/),
      expect.anything(),
    );
  });

  // Access is the client gate's call, which can say why.
  it("leaves a forbidden Workspace to the access gate", async () => {
    stubWorkspaceRead(403);

    await expect(renderLayout()).resolves.toBeTruthy();
  });
});

describe("WorkspaceLayout metadata", () => {
  const metadataFor = () =>
    generateMetadata({
      params: Promise.resolve({ orgId: "org1", workspaceId: "ws1" }),
    });

  // A page titled "Chats" inside it reads "Chats | Research | Platypus"; the
  // Workspace home, which names no title of its own, reads "Research | Platypus".
  it("names the Workspace in the title of every page inside it", async () => {
    stubWorkspaceRead(200);

    await expect(metadataFor()).resolves.toMatchObject({
      title: { default: "Research", template: "%s | Research | Platypus" },
    });
  });

  it("leaves the title to the app when the Workspace cannot be read", async () => {
    stubWorkspaceRead(500);

    const metadata = await metadataFor();
    expect(metadata.title).toBeUndefined();
  });
});
