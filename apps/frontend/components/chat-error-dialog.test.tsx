import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { setupUser } from "@/test/test-utils";

const copyWithToast = vi.hoisted(() => vi.fn());
vi.mock("@/lib/clipboard", () => ({ copyWithToast }));

import { ChatErrorDialog } from "./chat-error-dialog";

// why: a property, so an explicit undefined isn't defaulted
function renderDialog(
  { error }: { error?: Error } = { error: new Error("Rate limited") },
) {
  const onOpenChange = vi.fn();
  render(<ChatErrorDialog isOpen onOpenChange={onOpenChange} error={error} />);
  return onOpenChange;
}

function copyButton() {
  return screen.getByRole("button", { name: "Copy error details" });
}
// why: no accessible name, so compare the markup with its resting state
function iconMarkup() {
  return copyButton().innerHTML;
}

beforeEach(() => copyWithToast.mockReset());
afterEach(() => vi.useRealTimers());

describe("ChatErrorDialog", () => {
  it("shows the error message", () => {
    renderDialog();

    expect(screen.getByText("Rate limited")).toBeInTheDocument();
  });

  it.each([undefined, new Error("")])(
    "falls back to a generic message for %s",
    (error) => {
      renderDialog({ error });

      expect(
        screen.getByText("An unknown error occurred."),
      ).toBeInTheDocument();
    },
  );

  it("closes on OK", async () => {
    const onOpenChange = renderDialog();

    await setupUser().click(screen.getByRole("button", { name: "OK" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  // why: the button shows its own success state, so no success toast is asked for
  it("copies the message and briefly shows a check", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    copyWithToast.mockResolvedValue(true);
    renderDialog();
    const resting = iconMarkup();

    await setupUser().click(copyButton());

    expect(copyWithToast).toHaveBeenCalledWith("Rate limited", false);
    await waitFor(() => expect(iconMarkup()).not.toBe(resting));
    vi.advanceTimersByTime(2000);
    await waitFor(() => expect(iconMarkup()).toBe(resting));
  });

  // why: copyWithToast already reported the failure; the icon must not claim success
  it("keeps the copy icon when copying fails", async () => {
    copyWithToast.mockResolvedValue(false);
    renderDialog();
    const resting = iconMarkup();

    await setupUser().click(copyButton());

    await waitFor(() => expect(copyWithToast).toHaveBeenCalled());
    expect(iconMarkup()).toBe(resting);
  });
});
