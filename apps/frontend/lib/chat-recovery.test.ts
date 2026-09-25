// @vitest-environment node
import { describe, it, expect } from "vitest";
import type { ChatStatus as RunStatus } from "@platypus/schemas";
import type { ChatStatus as TurnStatus } from "ai";
import type { PlatypusUIMessage } from "@platypus/backend/src/types";
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

const user = (text: string): PlatypusUIMessage =>
  ({
    id: `u-${text}`,
    role: "user",
    parts: [{ type: "text", text }],
  }) as PlatypusUIMessage;

const assistant = (text: string, extraParts = 0): PlatypusUIMessage =>
  ({
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
  }) as PlatypusUIMessage;

/** The three readings the recovery decisions are made from. */
const belief = (
  runStatus: RunStatus | undefined,
  turnStatus: TurnStatus,
  turnEstablished = false,
) => ({ runStatus, turnStatus, turnEstablished });

describe("chatPollIntervalMs", () => {
  // This tab's own stream is the live source; a read under it lands nowhere.
  // A row already reading `running` (the read taken at submit) is no reason
  // either.
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

  // The recovery itself: a dropped stream leaves the turn at `error` while the
  // run carries on, and this is what gets the partial answer moving again.
  it("keeps polling after a stream drops while the run is still going", () => {
    expect(chatPollIntervalMs(belief("running", "error", true))).toBe(
      CHAT_POLL_INTERVAL_MS,
    );
  });

  // A brand-new Chat whose row was still absent when the drop happened: there
  // is no status to lean on, only the fact that bytes had been arriving.
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

  // Including a `succeeded` left over from the previous turn: the read taken
  // when the turn ends replaces it with this turn's status, and polling
  // resumes from that.
  it("stops once the server reports an outcome for a dropped turn", () => {
    for (const runStatus of ["succeeded", "failed", "cancelled"] as const) {
      expect(chatPollIntervalMs(belief(runStatus, "error", true))).toBe(0);
    }
  });

  // Nothing streamed, so no run was ever taken — a rejected attachment or a
  // refused submission. Polling for an outcome that will never come would spin
  // forever.
  it("does not poll a turn the server refused", () => {
    expect(chatPollIntervalMs(belief(undefined, "error", false))).toBe(0);
  });

  it("does not poll an idle Chat", () => {
    expect(chatPollIntervalMs(belief("succeeded", "ready"))).toBe(0);
    expect(chatPollIntervalMs(belief(undefined, "ready"))).toBe(0);
  });
});

describe("isRunHeldElsewhere", () => {
  // The case the old guard missed: it required the local status to be `ready`,
  // and a dropped stream leaves it at `error`, so the composer came back and a
  // second concurrent run could be fired into a Chat that already had one.
  it("holds the composer after a stream drops mid-run", () => {
    expect(isRunHeldElsewhere(belief("running", "error", true))).toBe(true);
  });

  it("holds the composer after a drop on a Chat with no row yet", () => {
    expect(isRunHeldElsewhere(belief(undefined, "error", true))).toBe(true);
  });

  it("holds the composer for a tab that arrived mid-run", () => {
    expect(isRunHeldElsewhere(belief("running", "ready"))).toBe(true);
  });

  // This tab IS the one streaming, so the ordinary streaming controls apply
  // rather than the reconnected-to-someone-else's-run ones.
  it("leaves a turn this tab is streaming alone", () => {
    expect(isRunHeldElsewhere(belief("running", "streaming"))).toBe(false);
    expect(isRunHeldElsewhere(belief("running", "submitted"))).toBe(false);
  });

  // A turn that genuinely failed must leave the composer usable, or there is no
  // way to retry.
  it("releases the composer when no run is live", () => {
    expect(isRunHeldElsewhere(belief("failed", "error", true))).toBe(false);
    expect(isRunHeldElsewhere(belief(undefined, "ready"))).toBe(false);
  });

  // The trap the previous case would walk into if `turnEstablished` were
  // ignored: a brand-new Chat whose first submission was refused has no row and
  // an `error` status, and the composer would be locked with no way out.
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

  // The reported symptom: a backgrounded tab's socket teardown was reported as
  // a failed turn, while the run was healthy and completed normally.
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

  // Nothing streamed, so there is no run to recover: a rejected attachment, a
  // duplicate submission answered 409, a network that was never there.
  it("reports a request that never established, whatever the row says", () => {
    for (const runStatus of ["running", "succeeded", undefined] as const) {
      expect(
        classifyChatError({ error, ...belief(runStatus, "error", false) }),
      ).toBe("failure");
    }
  });
});

describe("composerTurnStatus", () => {
  // A run this tab is not receiving reads as streaming, so the submit button is
  // a stop button and Enter is blocked.
  it("presents a run held elsewhere as streaming", () => {
    expect(composerTurnStatus(belief("running", "ready"), "none")).toBe(
      "streaming",
    );
    expect(
      composerTurnStatus(belief("running", "error", true), "recovering"),
    ).toBe("streaming");
  });

  // The defect this exists for: once recovery finishes the turn is still sitting
  // at `error`, and passing that through puts a failure icon on the submit
  // button — the same "a dropped connection reported as a failed turn" symptom
  // the modal fix removed, only moved onto the button.
  it("clears a recovered drop rather than leaving a failure on the button", () => {
    expect(composerTurnStatus(belief("succeeded", "error", true), "none")).toBe(
      "ready",
    );
  });

  // A turn that genuinely failed keeps its reading: the button should say so.
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
    // The row is final and the canonical form of the transcript — rewritten
    // attachment URLs, normalized tool parts — so an otherwise-identical
    // snapshot lands rather than leaving the page on its own version.
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

    // Deleting every message reaches other tabs too.
    it("applies an emptied Chat", () => {
      expect(snapshotMayLand([], [user("q"), a1("a")], "succeeded")).toBe(true);
    });
  });

  describe("while the run is in progress", () => {
    // The row is flushed on an interval, so mid-run it holds less text than the
    // stream has already shown. Applying it would make the answer shorten.
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

    // Only the leaf grows during a run, so a message deleted further up in
    // another tab still reaches this one.
    it("applies a mid-path delete under the same leaf", () => {
      const held = [user("q"), a1("an answer"), user("more"), a2("partial")];
      const snapshot = [user("q"), user("more"), a2("partial")];

      expect(snapshotMayLand(snapshot, held, "running")).toBe(true);
    });

    // A connection dropped before the reply's first flush: the row still ends
    // at the question, and the partial reply on screen must stay.
    it("refuses a snapshot ending at a message held further up", () => {
      const held = [user("q"), a1("a partial reply")];

      expect(snapshotMayLand([user("q")], held, "running")).toBe(false);
    });

    // Another tab's run, on a path this tab is not showing.
    it("applies a longer snapshot for a different path", () => {
      const held = [user("q"), a1("an answer")];
      const snapshot = [user("q"), a2("another answer"), user("next")];

      expect(snapshotMayLand(snapshot, held, "running")).toBe(true);
    });

    // A tab that arrived mid-run holds nothing, so anything lands.
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

  // Deleting every message leaves a row with none, which other tabs must see.
  it("reads an emptied Chat as an empty snapshot", () => {
    expect(snapshotMessages({ messages: [] } as never)).toEqual([]);
  });

  // A brand-new Chat's row does not exist yet, and the read resolves to null
  // rather than throwing.
  it("reads an absent row as no snapshot", () => {
    expect(snapshotMessages(null)).toBeUndefined();
    expect(snapshotMessages(undefined)).toBeUndefined();
  });
});
