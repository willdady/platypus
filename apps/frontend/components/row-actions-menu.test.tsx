import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Pin } from "lucide-react";
import { openDropdownMenu } from "@/test/test-utils";
import { menuItemLabels } from "@/test/list-test-harness";
import { RowActionsMenu } from "./row-actions-menu";

const noop = () => {};

const pin = { label: "Pin", icon: <Pin />, onSelect: noop };

describe("RowActionsMenu", () => {
  it("orders Edit, actions, Clone, Enable/Disable, separator, Delete", async () => {
    render(
      <RowActionsMenu
        name="Bot"
        edit={{ href: "/edit" }}
        actions={[pin]}
        clone={{ onSelect: noop }}
        toggle={{ enabled: true, onSelect: noop }}
        remove={{ onSelect: noop }}
      />,
    );
    await openDropdownMenu();

    expect(menuItemLabels()).toEqual([
      "Edit",
      "Pin",
      "Clone",
      "Disable",
      "Delete",
    ]);
    const separator = screen.getByRole("separator");
    expect(
      separator.compareDocumentPosition(
        screen.getByRole("menuitem", { name: "Delete" }),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      separator.compareDocumentPosition(
        screen.getByRole("menuitem", { name: "Disable" }),
      ) & Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
  });

  it("reads Edit in org settings and Detach for a Shared row", async () => {
    render(
      <RowActionsMenu
        name="Bot"
        shared
        edit={{ href: "/org/edit" }}
        actions={[pin]}
        remove={{ onSelect: noop }}
      />,
    );
    await openDropdownMenu();

    expect(menuItemLabels()).toEqual(["Edit in org settings", "Pin", "Detach"]);
    expect(
      screen.getByRole("menuitem", { name: "Edit in org settings" }),
    ).toHaveAttribute("href", "/org/edit");
    expect(screen.getByRole("menuitem", { name: "Detach" })).not.toHaveClass(
      "text-destructive",
    );
  });

  it("shows only the actions, with no separator, for a Shared row without edit or remove", async () => {
    render(<RowActionsMenu name="Bot" shared actions={[pin]} />);
    await openDropdownMenu();

    expect(menuItemLabels()).toEqual(["Pin"]);
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
  });

  it("renders nothing when given nothing", () => {
    const { container } = render(<RowActionsMenu name="Bot" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("disables an action marked disabled", async () => {
    render(
      <RowActionsMenu name="Bot" actions={[{ ...pin, disabled: true }]} />,
    );
    await openDropdownMenu();

    expect(screen.getByRole("menuitem", { name: "Pin" })).toHaveAttribute(
      "data-disabled",
    );
  });

  it("renders an href action as a link", async () => {
    const onSelect = vi.fn();
    render(
      <RowActionsMenu
        name="Bot"
        actions={[{ label: "View runs", icon: <Pin />, href: "/runs" }]}
        remove={{ onSelect }}
      />,
    );
    await openDropdownMenu();

    expect(screen.getByRole("menuitem", { name: "View runs" })).toHaveAttribute(
      "href",
      "/runs",
    );
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveClass(
      "text-destructive",
    );
  });

  it("keeps a Cmd-click on a link item for the browser's new tab", async () => {
    render(<RowActionsMenu name="Bot" edit={{ href: "/edit" }} />);
    await openDropdownMenu();

    // fireEvent returns false when a handler called preventDefault.
    expect(
      fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }), {
        metaKey: true,
      }),
    ).toBe(true);
  });

  it("keeps a menu click from reaching the row's own link", async () => {
    const onRowClick = vi.fn();
    render(
      // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
      <div onClick={onRowClick}>
        <RowActionsMenu name="Bot" remove={{ onSelect: noop }} />
      </div>,
    );
    await openDropdownMenu();
    onRowClick.mockClear();

    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(onRowClick).not.toHaveBeenCalled();
  });
});
