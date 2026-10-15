"use client";

import { useState } from "react";
import type { ChatStatus } from "ai";
import { isTurnInFlight } from "@/lib/chat-recovery";

const ANNOUNCEMENTS: Partial<Record<ChatStatus, string>> = {
  ready: "Reply complete.",
  error: "The reply failed.",
};

/**
 * One polite announcement per turn. The transcript is marked busy while a reply
 * streams, so screen readers don't read it token by token; this says when the
 * reply has finished, or failed, which the busy transcript alone never does.
 */
export function TurnAnnouncer({ status }: { status: ChatStatus }) {
  const [prevStatus, setPrevStatus] = useState(status);
  const [message, setMessage] = useState("");
  if (status !== prevStatus) {
    setPrevStatus(status);
    if (isTurnInFlight(status)) setMessage("");
    else if (isTurnInFlight(prevStatus))
      setMessage(ANNOUNCEMENTS[status] ?? "");
  }

  return (
    <div role="status" className="sr-only">
      {message}
    </div>
  );
}
