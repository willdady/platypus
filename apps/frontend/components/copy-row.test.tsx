import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { toastError, toastMock, toastSuccess } from "@/lib/test-utils";

const copyToClipboard = vi.hoisted(() => vi.fn());
vi.mock("@/lib/clipboard", () => ({ copyToClipboard }));
vi.mock("sonner", () => toastMock);

import { CopyRow } from "./copy-row";

const renderRow = (multiline = false) =>
  render(
    <CopyRow
      id="card-url"
      label="Agent card URL"
      value={multiline ? "line one\nline two" : "https://example.com/card"}
      copiedMessage="Agent card URL copied to clipboard"
      multiline={multiline}
    />,
  );

beforeEach(() => {
  copyToClipboard.mockReset();
  toastError.mockReset();
  toastSuccess.mockReset();
});

describe("CopyRow", () => {
  it("copies the value and says so", async () => {
    copyToClipboard.mockResolvedValue(true);
    renderRow();

    expect(screen.getByLabelText("Agent card URL")).toHaveValue(
      "https://example.com/card",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Copy agent card url" }),
    );

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        "Agent card URL copied to clipboard",
      ),
    );
    expect(copyToClipboard).toHaveBeenCalledWith("https://example.com/card");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("selects the value for a manual copy when copying fails", async () => {
    copyToClipboard.mockResolvedValue(false);
    renderRow();

    const input = screen.getByLabelText<HTMLInputElement>("Agent card URL");
    fireEvent.click(
      screen.getByRole("button", { name: "Copy agent card url" }),
    );

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Couldn't copy. Select the text and press Ctrl+C.",
      ),
    );
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("shows a multi-line value in a text area, one row per line", () => {
    renderRow(true);

    const area = screen.getByLabelText("Agent card URL");
    expect(area.tagName).toBe("TEXTAREA");
    expect(area).toHaveAttribute("rows", "2");
  });
});
