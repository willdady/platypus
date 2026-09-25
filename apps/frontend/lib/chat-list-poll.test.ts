// @vitest-environment node
import { describe, it, expect } from "vitest";
import { UNTITLED_CHAT_TITLE } from "@platypus/schemas";
import {
  CHAT_LIST_POLL_INTERVAL_MS,
  MISSING_CHAT_WATCH_MS,
  UNTITLED_CHAT_WATCH_MS,
  activeChatIdFromPathname,
  chatListPoll,
  type ListedChat,
  type WatchedChat,
} from "./chat-list-poll";

const NOW = Date.parse("2026-09-19T10:00:00.000Z");

const chat = (over: Partial<ListedChat> = {}): ListedChat => ({
  id: "chat-1",
  status: "succeeded",
  title: "A title",
  updatedAt: new Date(NOW - 10 * 60_000).toISOString(),
  ...over,
});

const poll = (
  over: Partial<Parameters<typeof chatListPoll>[0]> = {},
): ReturnType<typeof chatListPoll> =>
  chatListPoll({
    watched: [],
    listed: [],
    activeChatId: null,
    now: NOW,
    ...over,
  });

describe("activeChatIdFromPathname", () => {
  it("reads the chat id out of a chat route", () => {
    expect(
      activeChatIdFromPathname(
        "/org-1/workspace/ws-1/chat/c-1",
        "org-1",
        "ws-1",
      ),
    ).toBe("c-1");
  });

  it("ignores trailing segments below the chat", () => {
    expect(
      activeChatIdFromPathname(
        "/org-1/workspace/ws-1/chat/c-1/settings",
        "org-1",
        "ws-1",
      ),
    ).toBe("c-1");
  });

  it("returns null off a chat route", () => {
    expect(
      activeChatIdFromPathname("/org-1/workspace/ws-1/agents", "org-1", "ws-1"),
    ).toBeNull();
    expect(
      activeChatIdFromPathname("/org-1/workspace/ws-1/chat", "org-1", "ws-1"),
    ).toBeNull();
  });

  it("returns null for another workspace's chat", () => {
    expect(
      activeChatIdFromPathname(
        "/org-1/workspace/ws-2/chat/c-1",
        "org-1",
        "ws-1",
      ),
    ).toBeNull();
  });

  it("tolerates missing route params", () => {
    expect(
      activeChatIdFromPathname(
        "/org-1/workspace/ws-1/chat/c-1",
        undefined,
        "ws-1",
      ),
    ).toBeNull();
  });
});

describe("chatListPoll: what is being waited for", () => {
  it("starts watching an active chat the list does not have", () => {
    expect(poll({ activeChatId: "c-1" }).watched).toEqual([
      { id: "c-1", since: NOW },
    ]);
  });

  it("does not watch an active chat the list already has", () => {
    expect(
      poll({ listed: [chat({ id: "c-1" })], activeChatId: "c-1" }).watched,
    ).toEqual([]);
  });

  it("keeps watching a chat after the user navigates away from it", () => {
    const watched: WatchedChat[] = [{ id: "c-1", since: NOW - 1_000 }];
    expect(
      poll({
        watched,
        listed: [chat({ id: "c-2" })],
        activeChatId: "c-2",
      }).watched,
    ).toEqual(watched);
  });

  it("stops watching a chat once it lands in the list", () => {
    expect(
      poll({
        watched: [{ id: "c-1", since: NOW - 1_000 }],
        listed: [chat({ id: "c-1" }), chat({ id: "c-2" })],
        activeChatId: "c-2",
      }).watched,
    ).toEqual([]);
  });

  it("gives up on a chat that never appears", () => {
    expect(
      poll({
        watched: [{ id: "c-1", since: NOW - MISSING_CHAT_WATCH_MS - 1 }],
        activeChatId: null,
      }).watched,
    ).toEqual([]);
  });

  it("does not renew an exhausted watch just because that chat is on screen", () => {
    const exhausted = { id: "c-1", since: NOW - MISSING_CHAT_WATCH_MS - 1 };
    const { watched, intervalMs } = poll({
      watched: [exhausted],
      activeChatId: "c-1",
    });
    expect(watched).toEqual([exhausted]);
    expect(intervalMs).toBe(0);
  });

  it("carries watches untouched while a search filters the list", () => {
    const watched: WatchedChat[] = [{ id: "c-1", since: NOW - 1_000 }];
    expect(
      poll({ watched, activeChatId: "c-2", isSearching: true }).watched,
    ).toEqual(watched);
  });
});

describe("chatListPoll: when to read the list again", () => {
  it("does not poll in the steady state", () => {
    expect(poll({ listed: [chat()] }).intervalMs).toBe(0);
  });

  it("does not poll before the first list arrives", () => {
    expect(poll({ listed: undefined, activeChatId: "c-1" }).intervalMs).toBe(0);
  });

  it("polls while a listed chat is running", () => {
    expect(poll({ listed: [chat({ status: "running" })] }).intervalMs).toBe(
      CHAT_LIST_POLL_INTERVAL_MS,
    );
  });

  it("polls while a watched chat is missing from the list", () => {
    expect(
      poll({
        watched: [{ id: "c-1", since: NOW - 1_000 }],
        listed: [chat({ id: "c-2" })],
        activeChatId: "c-2",
      }).intervalMs,
    ).toBe(CHAT_LIST_POLL_INTERVAL_MS);
  });

  it("polls for a chat the route has only just named", () => {
    expect(poll({ activeChatId: "c-1" }).intervalMs).toBe(
      CHAT_LIST_POLL_INTERVAL_MS,
    );
  });

  it("does not poll for a missing chat while a search filters the list", () => {
    expect(
      poll({
        watched: [{ id: "c-1", since: NOW - 1_000 }],
        activeChatId: "c-1",
        isSearching: true,
      }).intervalMs,
    ).toBe(0);
  });

  it("polls while a freshly finished chat is still untitled", () => {
    expect(
      poll({
        listed: [
          chat({
            title: UNTITLED_CHAT_TITLE,
            updatedAt: new Date(NOW - 5_000).toISOString(),
          }),
        ],
      }).intervalMs,
    ).toBe(CHAT_LIST_POLL_INTERVAL_MS);
  });

  it("gives up on a title that never arrives", () => {
    expect(
      poll({
        listed: [
          chat({
            title: UNTITLED_CHAT_TITLE,
            updatedAt: new Date(NOW - UNTITLED_CHAT_WATCH_MS - 1).toISOString(),
          }),
        ],
      }).intervalMs,
    ).toBe(0);
  });

  it("tolerates an unparseable updatedAt", () => {
    expect(
      poll({
        listed: [chat({ title: UNTITLED_CHAT_TITLE, updatedAt: "not a date" })],
      }).intervalMs,
    ).toBe(0);
  });

  it("stops once the awaited chat has arrived and settled", () => {
    const first = poll({ activeChatId: "c-1" });
    expect(first.intervalMs).toBe(CHAT_LIST_POLL_INTERVAL_MS);
    const second = poll({
      watched: first.watched,
      listed: [chat({ id: "c-1" })],
      activeChatId: "c-1",
    });
    expect(second.watched).toEqual([]);
    expect(second.intervalMs).toBe(0);
  });
});
