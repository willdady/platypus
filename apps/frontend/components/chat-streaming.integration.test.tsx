import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { UIMessageChunk } from "ai";
import {
  authMock,
  authState,
  jsonResponse,
  setupUser,
} from "@/test/test-utils";
import { Chat } from "./chat";

/**
 * The one test that runs the real `useChat`, the transport `Chat` builds and
 * the real message rendering together: `chat.test.tsx` stubs the chat hook and
 * the presentational tree to pin the wiring seams, so nothing else would catch
 * a request body the server cannot read or a stream that never reaches the
 * screen. Only the network is faked, at `fetch`.
 */

// The real provider resolves a better-auth session over the network; the
// signed-in owner is all the Chat needs from it.
vi.mock("@/components/auth-provider", () => authMock);

const BASE = "http://test/organizations/org1/workspaces/ws1";
const CHAT_ID = "chat-1";

const provider = {
  id: "p1",
  name: "OpenRouter",
  modelIds: [{ id: "m1", passthroughFileTypes: [] }],
};

const chunks: UIMessageChunk[] = [
  { type: "start", messageId: "a1" },
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: "Hel" },
  { type: "text-delta", id: "t1", delta: "lo" },
  { type: "text-end", id: "t1" },
  { type: "finish" },
];

const sseResponse = () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
        );
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "x-vercel-ai-ui-message-stream": "v1",
    },
  });
};

const reads: Record<string, unknown> = {
  [`${BASE}/providers`]: { results: [provider] },
  [`${BASE}/agents`]: { results: [] },
  [`${BASE}/tools`]: { results: [] },
  [`${BASE}/skills`]: { results: [] },
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  authState.user = { id: "u1" };
  authState.ownsWorkspace = true;
  fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    if (init?.method === "POST" && url === `${BASE}/chat`) {
      return Promise.resolve(sseResponse());
    }
    // A new Chat's row and the Workspace's Sandbox do not exist yet.
    return Promise.resolve(
      url in reads ? jsonResponse(200, reads[url]) : jsonResponse(404, {}),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
});

describe("Chat streaming", () => {
  it("posts the turn and renders the streamed reply", async () => {
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <Chat orgId="org1" workspaceId="ws1" chatId={CHAT_ID} />
      </SWRConfig>,
    );

    const user = setupUser();
    const input = await screen.findByPlaceholderText(
      "What would you like to know?",
    );
    await user.type(input, "Hi there{Enter}");

    expect(await screen.findByText("Hello")).toBeInTheDocument();
    expect(screen.getByText("Hi there")).toBeInTheDocument();

    const post = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    );
    expect(post?.[0]).toBe(`${BASE}/chat`);
    const body = JSON.parse((post?.[1] as RequestInit).body as string);
    expect(body).toMatchObject({
      id: CHAT_ID,
      orgId: "org1",
      workspaceId: "ws1",
      parentId: null,
      providerId: "p1",
      modelId: "m1",
      search: false,
      message: {
        role: "user",
        parts: [{ type: "text", text: "Hi there" }],
      },
    });
    expect(body).not.toHaveProperty("messages");
  });
});
