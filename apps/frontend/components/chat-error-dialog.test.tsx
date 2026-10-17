import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { setupUser } from "@/test/test-utils";

const copyWithToast = vi.hoisted(() => vi.fn());
vi.mock("@/lib/clipboard", () => ({ copyWithToast }));

import { ChatErrorDialog } from "./chat-error-dialog";

// Takes the error as a property so an explicit `undefined` isn't defaulted.
const renderDialog = (
  { error }: { error?: Error } = { error: new Error("Rate limited") },
) => {
  const onOpenChange = vi.fn();
  render(<ChatErrorDialog isOpen onOpenChange={onOpenChange} error={error} />);
  return onOpenChange;
};

const copyButton = () =>
  screen.getByRole("button", { name: "Copy error details" });
// lucide tags each icon's svg with its name; the swap has no accessible name.
const showsCheck = () => copyButton().innerHTML.includes("lucide-check");

beforeEach(() => copyWithToast.mockReset());

describe("ChatErrorDialog", () => {
  // The failed turn's reason is what the user needs to act on.
  it("shows the error message", () => {
    renderDialog();

    expect(screen.getByText("Rate limited")).toBeInTheDocument();
  });

  // An error with no message must still say something went wrong.
  it.each([undefined, new Error("")])(
    "falls back to a generic message for %s",
    (error) => {
      renderDialog({ error });

      expect(
        screen.getByText("An unknown error occurred."),
      ).toBeInTheDocument();
    },
  );

  it("closes on Ok", async () => {
    const onOpenChange = renderDialog();

    await setupUser().click(screen.getByRole("button", { name: "Ok" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  // The button shows its own success state, so no success toast is asked
  // for, and it resets so a second copy reads the same.
  it("copies the message and briefly shows a check", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    copyWithToast.mockResolvedValue(true);
    renderDialog();
    expect(showsCheck()).toBe(false);

    await setupUser().click(copyButton());

    expect(copyWithToast).toHaveBeenCalledWith("Rate limited", false);
    await waitFor(() => expect(showsCheck()).toBe(true));
    vi.advanceTimersByTime(2000);
    await waitFor(() => expect(showsCheck()).toBe(false));
    vi.useRealTimers();
  });

  // copyWithToast already reported the failure; the icon must not claim
  // success.
  it("keeps the copy icon when copying fails", async () => {
    copyWithToast.mockResolvedValue(false);
    renderDialog();

    await setupUser().click(copyButton());

    await waitFor(() => expect(copyWithToast).toHaveBeenCalled());
    expect(showsCheck()).toBe(false);
  });
});
