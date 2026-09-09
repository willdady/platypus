import { describe, it, expect, beforeAll, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import { installRadixPointerPolyfills } from "@/lib/test-utils";

beforeAll(() => {
  installRadixPointerPolyfills();
});

function Menu({
  onSelect,
  ...props
}: React.ComponentProps<typeof DropdownMenu> & { onSelect?: () => void }) {
  return (
    <DropdownMenu {...props}>
      <DropdownMenuTrigger>Open</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={onSelect}>Delete</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Radix marks everything outside the open menu `aria-hidden`, so the trigger
 * disappears from the accessibility tree while it is open. Query the slot.
 */
const trigger = () => {
  const el = document.querySelector<HTMLElement>(
    '[data-slot="dropdown-menu-trigger"]',
  );
  if (!el) throw new Error("No dropdown menu trigger rendered");
  return el;
};
const isOpen = () => trigger().getAttribute("data-state") === "open";

// The pointer type is the whole point of these tests, so spell out each gesture
// rather than leaning on fireEvent defaults (jsdom leaves `pointerType` empty).
const press = (el: Element, pointerType: string) =>
  fireEvent.pointerDown(el, { button: 0, pointerId: 1, pointerType });
const release = (el: Element, pointerType: string) =>
  fireEvent.pointerUp(el, { button: 0, pointerId: 1, pointerType });
const click = (el: Element) => fireEvent.click(el, { button: 0 });

/** A completed touch tap: down, up, then the click the browser synthesises. */
const tap = (el: Element) => {
  press(el, "touch");
  release(el, "touch");
  click(el);
};

describe("DropdownMenuTrigger pointer handling", () => {
  it("does not open on a touch pointerdown", () => {
    render(<Menu />);

    press(trigger(), "touch");

    expect(isOpen()).toBe(false);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("stays closed when a touch turns into a scroll", () => {
    render(<Menu />);

    // A scroll gesture: the browser suppresses the click, so none is fired.
    press(trigger(), "touch");
    fireEvent.pointerMove(trigger(), { pointerId: 1, pointerType: "touch" });
    release(document.body, "touch");

    expect(isOpen()).toBe(false);
  });

  it("opens on a completed touch tap", () => {
    render(<Menu />);

    tap(trigger());

    expect(isOpen()).toBe(true);
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("closes on a second touch tap", () => {
    render(<Menu defaultOpen />);
    expect(isOpen()).toBe(true);

    tap(trigger());

    expect(isOpen()).toBe(false);
  });

  it("opens immediately on a mouse pointerdown", () => {
    render(<Menu />);

    press(trigger(), "mouse");

    expect(isOpen()).toBe(true);
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("does not close again when a mouse press is followed by its click", () => {
    render(<Menu />);

    press(trigger(), "mouse");
    release(trigger(), "mouse");
    click(trigger());

    expect(isOpen()).toBe(true);
  });

  it("ignores a right-click or ctrl-click pointerdown", () => {
    render(<Menu />);

    fireEvent.pointerDown(trigger(), {
      button: 2,
      pointerId: 1,
      pointerType: "mouse",
    });
    expect(isOpen()).toBe(false);

    fireEvent.pointerDown(trigger(), {
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
      ctrlKey: true,
    });
    expect(isOpen()).toBe(false);
  });

  it("selects an item on a mouse press-drag-release gesture", () => {
    const onSelect = vi.fn();
    render(<Menu onSelect={onSelect} />);

    press(trigger(), "mouse");
    release(screen.getByRole("menuitem", { name: "Delete" }), "mouse");

    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("does not open on a disabled trigger", () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger disabled>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    press(trigger(), "mouse");
    click(trigger());
    expect(isOpen()).toBe(false);

    tap(trigger());
    expect(isOpen()).toBe(false);
  });

  it("still opens from the keyboard", () => {
    render(<Menu />);

    fireEvent.keyDown(trigger(), { key: "Enter" });
    expect(isOpen()).toBe(true);

    fireEvent.keyDown(trigger(), { key: "Enter" });
    expect(isOpen()).toBe(false);

    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(isOpen()).toBe(true);
  });

  it("composes the call site's own pointer handlers", () => {
    const onPointerDown = vi.fn();
    const onClick = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger onPointerDown={onPointerDown} onClick={onClick}>
          Open
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    tap(trigger());

    expect(onPointerDown).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(isOpen()).toBe(true);
  });

  describe("a call site cancelling the gesture on pointerdown", () => {
    const CancellingMenu = () => (
      <DropdownMenu>
        <DropdownMenuTrigger onPointerDown={(e) => e.preventDefault()}>
          Open
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    it("suppresses the mouse press and the click that follows", () => {
      render(<CancellingMenu />);

      press(trigger(), "mouse");
      expect(isOpen()).toBe(false);

      release(trigger(), "mouse");
      click(trigger());
      expect(isOpen()).toBe(false);
    });

    it("suppresses a completed touch tap too", () => {
      render(<CancellingMenu />);

      tap(trigger());

      expect(isOpen()).toBe(false);
    });
  });

  it("opens on a touch tap when the call site's click prevents default", () => {
    // Triggers nested in a link do this to stop the link navigating.
    render(
      <DropdownMenu>
        <DropdownMenuTrigger onClick={(e) => e.preventDefault()}>
          Open
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    tap(trigger());

    expect(isOpen()).toBe(true);
  });

  it("works with asChild", () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button">Open</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    press(trigger(), "touch");
    expect(isOpen()).toBe(false);

    click(trigger());
    expect(isOpen()).toBe(true);
  });
});

describe("DropdownMenu open state", () => {
  it("honours defaultOpen", () => {
    render(<Menu defaultOpen />);

    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("reports uncontrolled changes through onOpenChange", () => {
    const onOpenChange = vi.fn();
    render(<Menu onOpenChange={onOpenChange} />);

    press(trigger(), "mouse");

    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it("stays closed when controlled open is false", () => {
    const onOpenChange = vi.fn();
    render(<Menu open={false} onOpenChange={onOpenChange} />);

    press(trigger(), "mouse");

    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(isOpen()).toBe(false);
  });

  it("renders open when controlled open is true", () => {
    render(<Menu open onOpenChange={vi.fn()} />);

    expect(screen.getByRole("menu")).toBeInTheDocument();
  });
});
