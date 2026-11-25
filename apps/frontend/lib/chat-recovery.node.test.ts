import { describe, it, expect } from "vitest";
import type {
  ChatStatus as RunStatus,
  PlatypusUIMessage,
} from "@platypus/schemas";
import type { ChatStatus as TurnStatus } from "ai";
import {
  CHAT_POLL_INTERVAL_MS,
  chatPollIntervalMs,
  classifyChatError,
  composerTurnStatus,
  isRunHeldElsewhere,
  snapshotMayLand,
  snapshotMessages,
  transcriptExtent,
} from "./chat-recovery";

function user(text: string): PlatypusUIMessage {
  return {
    id: `u-${text}`,
    role: "user",
    parts: [{ type: "text", text }],
  };
}

function assistant(text: string, extraParts = 0): PlatypusUIMessage {
  return {
    id: "a-1",
    role: "assistant",
    parts: [
      { type: "text", text },
      ...Array.from({ length: extraParts }, (_, i) => ({
        type: "tool-getCard",
        toolCallId: `call-${i}`,
        state: "output-available",
        input: {},
        output: {},
      })),
    ],
  } as PlatypusUIMessage;
}

function belief(
  runStatus: RunStatus | undefined,
  turnStatus: TurnStatus,
  turnEstablished = false,
) {
  return { runStatus, turnStatus, turnEstablished };
}

describe("chatPollIntervalMs", () => {
  it.each([
    ["succeeded", "submitted"],
    ["succeeded", "streaming"],
    ["running", "submitted"],
    ["running", "streaming"],
    [undefined, "submitted"],
    [undefined, "streaming"],
  ] as const)(
    "does not poll under this tab's own stream (row %s, turn %s)",
    (runStatus, turnStatus) => {
      expect(chatPollIntervalMs(belief(runStatus, turnStatus, true))).toBe(0);
    },
  );

  it("keeps polling after a stream drops while the run is still going", () => {
    expect(chatPollIntervalMs(belief("running", "error", true))).toBe(
      CHAT_POLL_INTERVAL_MS,
    );
  });

  it("keeps polling after a drop on a Chat with no row yet", () => {
    expect(chatPollIntervalMs(belief(undefined, "error", true))).toBe(
      CHAT_POLL_INTERVAL_MS,
    );
  });

  it("polls a run this tab did not start", () => {
    expect(chatPollIntervalMs(belief("running", "ready"))).toBe(
      CHAT_POLL_INTERVAL_MS,
    );
  });

  it("stops once the server reports an outcome for a dropped turn", () => {
    for (const runStatus of ["succeeded", "failed", "cancelled"] as const) {
      expect(chatPollIntervalMs(belief(runStatus, "error", true))).toBe(0);
    }
  });

  it("does not poll a turn the server refused", () => {
    expect(chatPollIntervalMs(belief(undefined, "error", false))).toBe(0);
  });

  it("does not poll an idle Chat", () => {
    expect(chatPollIntervalMs(belief("succeeded", "ready"))).toBe(0);
    expect(chatPollIntervalMs(belief(undefined, "ready"))).toBe(0);
  });
});

describe("isRunHeldElsewhere", () => {
  it("holds the composer after a stream drops mid-run", () => {
    expect(isRunHeldElsewhere(belief("running", "error", true))).toBe(true);
  });

  it("holds the composer after a drop on a Chat with no row yet", () => {
    expect(isRunHeldElsewhere(belief(undefined, "error", true))).toBe(true);
  });

  it("holds the composer for a tab that arrived mid-run", () => {
    expect(isRunHeldElsewhere(belief("running", "ready"))).toBe(true);
  });

  it("leaves a turn this tab is streaming alone", () => {
    expect(isRunHeldElsewhere(belief("running", "streaming"))).toBe(false);
    expect(isRunHeldElsewhere(belief("running", "submitted"))).toBe(false);
  });

  it("releases the composer when no run is live", () => {
    expect(isRunHeldElsewhere(belief("failed", "error", true))).toBe(false);
    expect(isRunHeldElsewhere(belief(undefined, "ready"))).toBe(false);
  });

  it("releases the composer after a refused submission on a new Chat", () => {
    expect(isRunHeldElsewhere(belief(undefined, "error", false))).toBe(false);
  });
});

describe("classifyChatError", () => {
  const error = new Error("Failed to fetch");

  it("says nothing when there is no error", () => {
    expect(
      classifyChatError({
        error: undefined,
        ...belief("running", "streaming"),
      }),
    ).toBe("none");
  });

  it("treats a drop from a live run as recovering, not a failure", () => {
    expect(
      classifyChatError({ error, ...belief("running", "error", true) }),
    ).toBe("recovering");
  });

  it("treats a drop on a Chat with no row yet as recovering", () => {
    expect(
      classifyChatError({ error, ...belief(undefined, "error", true) }),
    ).toBe("recovering");
  });

  it("says nothing when the run finished while the connection was gone", () => {
    expect(
      classifyChatError({ error, ...belief("succeeded", "error", true) }),
    ).toBe("none");
  });

  it("reports a run that reached a terminal failed status", () => {
    expect(
      classifyChatError({ error, ...belief("failed", "error", true) }),
    ).toBe("failure");
  });

  it("reports a request that never established, whatever the row says", () => {
    for (const runStatus of ["running", "succeeded", undefined] as const) {
      expect(
        classifyChatError({ error, ...belief(runStatus, "error", false) }),
      ).toBe("failure");
    }
  });
});

describe("composerTurnStatus", () => {
  it("presents a run held elsewhere as streaming", () => {
    expect(composerTurnStatus(belief("running", "ready"), "none")).toBe(
      "streaming",
    );
    expect(
      composerTurnStatus(belief("running", "error", true), "recovering"),
    ).toBe("streaming");
  });

  it("clears a recovered drop rather than leaving a failure on the button", () => {
    expect(composerTurnStatus(belief("succeeded", "error", true), "none")).toBe(
      "ready",
    );
  });

  it("keeps the error reading for a turn that actually failed", () => {
    expect(composerTurnStatus(belief("failed", "error", true), "failure")).toBe(
      "error",
    );
    expect(
      composerTurnStatus(belief(undefined, "error", false), "failure"),
    ).toBe("error");
  });

  it("passes an ordinary turn through untouched", () => {
    expect(composerTurnStatus(belief(undefined, "ready"), "none")).toBe(
      "ready",
    );
    expect(composerTurnStatus(belief("running", "streaming"), "none")).toBe(
      "streaming",
    );
    expect(composerTurnStatus(belief("running", "submitted"), "none")).toBe(
      "submitted",
    );
  });
});

describe("transcriptExtent", () => {
  it("counts messages, parts and text", () => {
    expect(transcriptExtent([user("hello"), assistant("hi there", 2)])).toEqual(
      {
        messages: 2,
        parts: 4,
        textLength: 13,
      },
    );
  });

  it("reads an absent transcript as nothing at all", () => {
    expect(transcriptExtent(undefined)).toEqual({
      messages: 0,
      parts: 0,
      textLength: 0,
    });
  });
});

describe("snapshotMayLand", () => {
  const a1 = (text: string) => ({ ...assistant(text), id: "a-1" });
  const a2 = (text: string) => ({ ...assistant(text), id: "a-2" });

  describe("once the run is over", () => {
    it("applies a snapshot equal to what is held", () => {
      const held = [user("q"), assistant("an answer", 1)];

      expect(snapshotMayLand([...held], held, "succeeded")).toBe(true);
    });

    it.each(["succeeded", "failed", "cancelled"] as const)(
      "applies a shorter snapshot when the run %s",
      (status) => {
        const held = [user("q"), a1("an answer"), user("gone")];

        expect(
          snapshotMayLand([user("q"), a1("an answer")], held, status),
        ).toBe(true);
      },
    );

    it("applies an emptied Chat", () => {
      expect(snapshotMayLand([], [user("q"), a1("a")], "succeeded")).toBe(true);
    });
  });

  describe("while the run is in progress", () => {
    it("refuses a snapshot whose leaf is behind the text on screen", () => {
      const held = [user("q"), a1("the first two thirds of an answer")];
      const snapshot = [user("q"), a1("the first third")];

      expect(snapshotMayLand(snapshot, held, "running")).toBe(false);
    });

    it("refuses a snapshot whose leaf is missing a part already held", () => {
      const held = [user("q"), assistant("same text", 2)];
      const snapshot = [user("q"), assistant("same text", 1)];

      expect(snapshotMayLand(snapshot, held, "running")).toBe(false);
    });

    it("applies a snapshot whose leaf has moved on", () => {
      const held = [user("q"), a1("the first third")];
      const snapshot = [user("q"), a1("the first third and the rest")];

      expect(snapshotMayLand(snapshot, held, "running")).toBe(true);
    });

    it("applies a mid-path delete under the same leaf", () => {
      const held = [user("q"), a1("an answer"), user("more"), a2("partial")];
      const snapshot = [user("q"), user("more"), a2("partial")];

      expect(snapshotMayLand(snapshot, held, "running")).toBe(true);
    });

    it("refuses a snapshot ending at a message held further up", () => {
      const held = [user("q"), a1("a partial reply")];

      expect(snapshotMayLand([user("q")], held, "running")).toBe(false);
    });

    it("applies a longer snapshot for a different path", () => {
      const held = [user("q"), a1("an answer")];
      const snapshot = [user("q"), a2("another answer"), user("next")];

      expect(snapshotMayLand(snapshot, held, "running")).toBe(true);
    });

    it("applies the first snapshot onto an empty transcript", () => {
      expect(snapshotMayLand([user("q"), a1("a")], [], "running")).toBe(true);
    });
  });
});

describe("snapshotMessages", () => {
  it("reads the messages off a fetched row", () => {
    const messages = [user("q")];
    expect(snapshotMessages({ messages } as never)).toBe(messages);
  });

  it("reads an emptied Chat as an empty snapshot", () => {
    expect(snapshotMessages({ messages: [] } as never)).toEqual([]);
  });

  it("reads an absent row as no snapshot", () => {
    expect(snapshotMessages(null)).toBeUndefined();
    expect(snapshotMessages(undefined)).toBeUndefined();
  });
});
