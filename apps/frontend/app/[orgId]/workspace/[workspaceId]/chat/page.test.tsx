import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { SWRConfig, type Cache } from "swr";

/**
 * The index route mints a chat id and replaces itself with that chat's URL
 * (issue #966). It renders the chat composer while it does, so a New chat
 * click never paints a frame without one.
 */
const state = {
  replace: vi.fn(),
  search: "",
};

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgId: "org-1", workspaceId: "ws-1" }),
  useRouter: () => ({ replace: state.replace }),
  useSearchParams: () => new URLSearchParams(state.search),
}));

vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://test",
  useAuth: () => ({ user: { id: "u1" } }),
}));

vi.mock("@/components/chat", () => ({
  Chat: (props: { chatId: string; initialAgentId?: string }) => (
    <div
      data-testid="chat"
      data-chat-id={props.chatId}
      data-agent-id={props.initialAgentId ?? ""}
    />
  ),
}));

import ChatPage from "./page";

const chatProps = () => {
  const el = screen.getByTestId("chat");
  return {
    chatId: el.getAttribute("data-chat-id")!,
    agentId: el.getAttribute("data-agent-id"),
  };
};

describe("ChatPage", () => {
  beforeEach(() => {
    state.replace.mockClear();
    state.search = "";
  });

  it("renders the chat with the id it redirects to", () => {
    render(<ChatPage />);

    const { chatId } = chatProps();
    expect(chatId).toBeTruthy();
    expect(state.replace).toHaveBeenCalledWith(
      `/org-1/workspace/ws-1/chat/${chatId}`,
    );
  });

  it("keeps the id stable across re-renders", () => {
    const { rerender } = render(<ChatPage />);
    const first = chatProps().chatId;

    rerender(<ChatPage />);

    expect(chatProps().chatId).toBe(first);
  });

  it("pre-selects the Agent and carries the query string through", () => {
    state.search = "agentId=agent-1";

    render(<ChatPage />);

    const { chatId, agentId } = chatProps();
    expect(agentId).toBe("agent-1");
    expect(state.replace).toHaveBeenCalledWith(
      `/org-1/workspace/ws-1/chat/${chatId}?agentId=agent-1`,
    );
  });

  it("caches the new Chat's row as absent", () => {
    const cache: Cache = new Map();

    render(
      <SWRConfig value={{ provider: () => cache }}>
        <ChatPage />
      </SWRConfig>,
    );

    const key = `http://test/organizations/org-1/workspaces/ws-1/chat/${chatProps().chatId}`;
    expect(cache.get(key)?.data).toBeNull();
  });
});
