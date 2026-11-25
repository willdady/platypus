import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  CHAT_RECONNECTING_MESSAGE,
  ChatReconnectingNotice,
} from "./chat-reconnecting-notice";

describe("ChatReconnectingNotice", () => {
  // why: the Chat docs quote this sentence, so it is pinned here
  it("says the reply is still being written", () => {
    render(<ChatReconnectingNotice />);

    expect(screen.getByRole("status")).toHaveTextContent(
      CHAT_RECONNECTING_MESSAGE,
    );
  });

  it("is announced politely rather than interrupting", () => {
    render(<ChatReconnectingNotice />);

    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
  });
});
