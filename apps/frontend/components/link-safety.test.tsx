import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { installRadixPointerPolyfills } from "@/lib/test-utils";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Markdown } from "./markdown";

beforeAll(installRadixPointerPolyfills);
afterEach(() => vi.unstubAllGlobals());

// A Kanban card: Markdown inside a modal Radix Dialog.
const Card = ({ body }: { body: string }) => {
  const [open, setOpen] = useState(true);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogTitle>Card</DialogTitle>
        <Markdown>{body}</Markdown>
      </DialogContent>
    </Dialog>
  );
};

const renderInDialog = (body: string) => render(<Card body={body} />);

// Streamdown opens the confirmation after an async link check; clicking inside
// act lets the nested layer finish mounting before the test presses Escape.
const clickLink = (name: string) =>
  act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });

const confirmation = () =>
  screen.getByRole("dialog", { name: "Open external link?" });

describe("link safety inside a Radix Dialog", () => {
  it("confirms an external link, showing the URL in full", async () => {
    renderInDialog("[example](https://example.com/a/long/path)");

    await clickLink("example");

    const dialog = confirmation();
    expect(
      within(dialog).getByText("https://example.com/a/long/path"),
    ).toBeInTheDocument();
  });

  it("closes on Close and leaves the parent dialog open", async () => {
    renderInDialog("[example](https://example.com)");
    await clickLink("example");
    const dialog = confirmation();

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));

    expect(screen.queryByRole("dialog", { name: "Open external link?" })).toBe(
      null,
    );
    expect(screen.getByRole("dialog", { name: "Card" })).toBeInTheDocument();
  });

  it("closes on Escape and leaves the parent dialog open", async () => {
    renderInDialog("[example](https://example.com)");
    await clickLink("example");
    const dialog = confirmation();

    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Open external link?" })).toBe(
      null,
    );
    expect(screen.getByRole("dialog", { name: "Card" })).toBeInTheDocument();
  });

  it("opens the link in a new tab on Open link", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    renderInDialog("[example](https://example.com)");
    await clickLink("example");
    const dialog = confirmation();

    fireEvent.click(within(dialog).getByRole("button", { name: "Open link" }));

    expect(open).toHaveBeenCalledWith(
      "https://example.com/",
      "_blank",
      "noreferrer",
    );
    expect(screen.queryByRole("dialog", { name: "Open external link?" })).toBe(
      null,
    );
  });

  it("copies the link", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    renderInDialog("[example](https://example.com)");
    await clickLink("example");
    const dialog = confirmation();

    fireEvent.click(within(dialog).getByRole("button", { name: "Copy link" }));

    expect(writeText).toHaveBeenCalledWith("https://example.com/");
  });

  it("opens a same-origin link without confirming", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    renderInDialog(`[home](${window.location.origin}/org/workspace)`);

    await clickLink("home");

    await vi.waitFor(() => expect(open).toHaveBeenCalled());
    expect(screen.queryByRole("dialog", { name: "Open external link?" })).toBe(
      null,
    );
  });
});
