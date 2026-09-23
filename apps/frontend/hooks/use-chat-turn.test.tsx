import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { UIMessage } from "ai";
import {
  resetSharedSpies,
  stubAcceptedSave,
  stubRejectedSave,
  toastError,
  toastMock,
} from "@/lib/test-utils";
import type { ChatSettings } from "@/hooks/use-chat-settings";
import type { ModelSelection } from "@/hooks/use-model-selection";
import { CHAT_MAX_STEPS_ERROR, CHAT_SELECTION_ERROR } from "@/lib/chat-turn";
import { reportPdf } from "@/lib/chat-test-fixtures";
import { useChatTurn } from "./use-chat-turn";

vi.mock("sonner", () => toastMock);

/**
 * A Chat turn starts from the composer, Regenerate and a resent edit, and all
 * three used to build their own request — so only the composer ran the
 * pre-turn checks and the post-send refresh (issue #971). These pin that the
 * three are judged identically, and that a refused turn touches nothing.
 */

const settings: ChatSettings = {
  instructions: "",
  temperature: undefined,
  topP: undefined,
  topK: undefined,
  seed: undefined,
  presencePenalty: undefined,
  frequencyPenalty: undefined,
  maxSteps: 10,
};
const direct: ModelSelection = { agentId: "", providerId: "p1", modelId: "m1" };

const harness = ({
  selection = direct,
  maxSteps = settings.maxSteps,
  runHeldElsewhere = false,
}: {
  selection?: ModelSelection;
  maxSteps?: number;
  runHeldElsewhere?: boolean;
} = {}) => {
  const calls: string[] = [];
  const spy = (name: string) =>
    vi.fn<(...args: unknown[]) => void>(() => void calls.push(name));
  const chat = {
    sendMessage: spy("sendMessage"),
    regenerate: spy("regenerate"),
    stop: spy("stop"),
    setMessages: spy("setMessages"),
  };
  const refreshChat = spy("refreshChat");
  const { result } = renderHook(() =>
    useChatTurn<UIMessage>({
      selection,
      settings: { ...settings, maxSteps },
      search: false,
      runHeldElsewhere,
      chat,
      refreshChat,
      backendUrl: "http://test",
      scope: { orgId: "org1", workspaceId: "ws1" },
      chatId: "chat-1",
    }),
  );
  return { turn: result.current, ...chat, refreshChat, calls };
};

const body = {
  providerId: "p1",
  modelId: "m1",
  ...settings,
  instructions: undefined,
  search: false,
};
const edit = { text: "Rewritten", files: [] };

type Turn = ReturnType<typeof harness>["turn"];
const starts: [string, (turn: Turn) => boolean][] = [
  ["send", (turn) => turn.send(edit)],
  ["regenerate", (turn) => turn.regenerate()],
  ["resendEdited", (turn) => turn.resendEdited(1, edit)],
];

beforeEach(() => resetSharedSpies());
afterEach(() => vi.unstubAllGlobals());

describe("useChatTurn refusing a turn", () => {
  it.each(starts)(
    "%s refuses an out-of-range Direct Max steps and touches nothing",
    (_, start) => {
      const h = harness({ maxSteps: 51 });

      expect(start(h.turn)).toBe(false);

      expect(toastError).toHaveBeenCalledWith(CHAT_MAX_STEPS_ERROR);
      expect(h.calls).toEqual([]);
    },
  );

  it.each(starts)(
    "%s refuses with no Agent and no model and touches nothing",
    (_, start) => {
      const h = harness({
        selection: { agentId: "", providerId: "", modelId: "" },
      });

      expect(start(h.turn)).toBe(false);

      expect(toastError).toHaveBeenCalledWith(CHAT_SELECTION_ERROR);
      expect(h.calls).toEqual([]);
    },
  );

  // The same condition that disables the composer.
  it.each(starts)(
    "%s refuses while a run is held elsewhere and touches nothing",
    (_, start) => {
      const h = harness({ runHeldElsewhere: true });

      expect(start(h.turn)).toBe(false);

      expect(h.calls).toEqual([]);
    },
  );
});

describe("useChatTurn starting a turn", () => {
  it("sends a composer message with the turn's body, then refreshes the row", () => {
    const h = harness();

    expect(h.turn.send({ text: "Hi", files: [reportPdf] })).toBe(true);

    expect(h.sendMessage).toHaveBeenCalledWith(
      { text: "Hi", files: [reportPdf] },
      { body },
    );
    expect(h.calls).toEqual(["sendMessage", "refreshChat"]);
  });

  // An attachment-only message is a real turn: the question was the file.
  it("stands in a text for a message with attachments and no words", () => {
    const h = harness();

    h.turn.send({ text: "", files: [reportPdf] });

    expect(h.sendMessage.mock.calls[0]).toEqual([
      { text: "Sent with attachments", files: [reportPdf] },
      { body },
    ]);
  });

  it("regenerates with the turn's body, then refreshes the row", () => {
    const h = harness();

    expect(h.turn.regenerate()).toBe(true);

    expect(h.regenerate).toHaveBeenCalledWith({ body });
    expect(h.calls).toEqual(["regenerate", "refreshChat"]);
  });

  it("truncates an edit's transcript before sending it, then refreshes", () => {
    const h = harness();

    expect(h.turn.resendEdited(1, edit)).toBe(true);

    expect(h.calls).toEqual(["setMessages", "sendMessage", "refreshChat"]);
    expect(h.sendMessage).toHaveBeenCalledWith(edit, { body });
    const update = h.setMessages.mock.calls[0][0] as unknown as (
      held: string[],
    ) => string[];
    expect(update(["u1", "a1", "u2"])).toEqual(["u1"]);
  });

  it("sends an Agent turn as the Agent alone", () => {
    const h = harness({
      selection: { agentId: "a1", providerId: "", modelId: "" },
      maxSteps: 51,
    });

    h.turn.regenerate();

    expect(h.regenerate).toHaveBeenCalledWith({
      body: { agentId: "a1", search: false },
    });
  });
});

describe("useChatTurn cancelling a turn", () => {
  it("posts the cancel and stops the stream", async () => {
    const fetchMock = stubAcceptedSave();
    const h = harness();

    h.turn.cancel();

    expect(h.stop).toHaveBeenCalled();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "http://test/organizations/org1/workspaces/ws1/chat/chat-1/cancel",
    );
    expect(init).toMatchObject({ method: "POST" });
    expect(toastError).not.toHaveBeenCalled();
  });

  it("says so when the cancel fails", async () => {
    stubRejectedSave("Run not found", 404);
    const h = harness();

    h.turn.cancel();

    expect(h.stop).toHaveBeenCalled();
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Run not found"),
    );
  });
});
