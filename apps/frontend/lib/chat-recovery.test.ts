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
  snapshotIsAtLeastAsComplete,
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
  // The reported bug in one assertion. An existing Chat's row still reads
  // `succeeded` from the previous turn at the moment the next one is sent, and
  // gating on that alone is a deadlock: only the poll would refresh it.
  it("polls a turn just submitted into a Chat whose row still reads succeeded", () => {
    expect(chatPollIntervalMs(belief("succeeded", "submitted"))).toBe(
      CHAT_POLL_INTERVAL_MS,
    );
  });

  it("polls while this tab is streaming", () => {
    expect(chatPollIntervalMs(belief("succeeded", "streaming"))).toBe(
      CHAT_POLL_INTERVAL_MS,
    );
  });

  // A brand-new Chat is read before its row exists, so there is no status at
  // all to gate on.
  it("polls a turn on a Chat that has no row yet", () => {
    expect(chatPollIntervalMs(belief(undefined, "submitted"))).toBe(
      CHAT_POLL_INTERVAL_MS,
    );
  });

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

describe("snapshotIsAtLeastAsComplete", () => {
  // The lagging-snapshot case directly: the row is flushed on an interval, so
  // mid-run it holds less text than the stream has already shown. Applying it
  // would make the answer visibly shorten.
  it("refuses a snapshot that is behind the text on screen", () => {
    const held = [user("q"), assistant("the first two thirds of an answer")];
    const snapshot = [user("q"), assistant("the first third")];

    expect(snapshotIsAtLeastAsComplete(snapshot, held)).toBe(false);
  });

  it("refuses a snapshot missing a part the client already has", () => {
    const held = [user("q"), assistant("same text", 2)];
    const snapshot = [user("q"), assistant("same text", 1)];

    expect(snapshotIsAtLeastAsComplete(snapshot, held)).toBe(false);
  });

  it("applies a snapshot that has moved on", () => {
    const held = [user("q"), assistant("the first third")];
    const snapshot = [user("q"), assistant("the first third and the rest")];

    expect(snapshotIsAtLeastAsComplete(snapshot, held)).toBe(true);
  });

  it("applies a snapshot carrying a whole extra message", () => {
    const held = [user("q")];
    const snapshot = [user("q"), assistant("an answer")];

    expect(snapshotIsAtLeastAsComplete(snapshot, held)).toBe(true);
  });

  // Initial hydration is the same comparison: nothing held, so anything wins.
  it("applies the first snapshot onto an empty transcript", () => {
    expect(snapshotIsAtLeastAsComplete([user("q"), assistant("a")], [])).toBe(
      true,
    );
  });

  // The row is the canonical form of the transcript — rewritten attachment
  // URLs, normalized tool parts — so an otherwise-identical snapshot has to be
  // allowed through rather than leaving the page on its own version until a
  // reload.
  it("applies a snapshot equal to what is held", () => {
    const held = [user("q"), assistant("an answer", 1)];

    expect(snapshotIsAtLeastAsComplete([...held], held)).toBe(true);
  });

  // A shorter transcript is a different conversation (an edit dropped the tail),
  // not a later state of this one, and the client's own view is the newer.
  it("refuses a snapshot with fewer messages", () => {
    const held = [user("q"), assistant("an answer"), user("follow up")];
    const snapshot = [user("q"), assistant("an answer")];

    expect(snapshotIsAtLeastAsComplete(snapshot, held)).toBe(false);
  });
});

describe("snapshotMessages", () => {
  it("reads the messages off a fetched row", () => {
    const messages = [user("q")];
    expect(snapshotMessages({ messages } as never)).toBe(messages);
  });

  // A brand-new Chat's row does not exist yet, and the read resolves to null
  // rather than throwing.
  it("reads an absent row as no snapshot", () => {
    expect(snapshotMessages(null)).toBeUndefined();
    expect(snapshotMessages(undefined)).toBeUndefined();
    expect(snapshotMessages({ messages: [] } as never)).toBeUndefined();
  });
});
