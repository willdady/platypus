import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TableList } from "./table-list";

const table = (
  <table>
    <tbody>
      <tr>
        <td>Ada</td>
      </tr>
    </tbody>
  </table>
);

function renderList(over: Partial<Parameters<typeof TableList>[0]> = {}) {
  return render(
    <TableList
      isLoading={false}
      data={{ results: [{ id: "1" }] }}
      error={null}
      subject="users"
      skeleton={<span>placeholder rows</span>}
      empty={<span>No users.</span>}
      isEmpty={false}
      {...over}
    >
      {table}
    </TableList>,
  );
}

describe("TableList", () => {
  it("announces the skeleton while the read is loading", () => {
    renderList({ isLoading: true });

    expect(
      screen.getByRole("status", { name: "Loading users" }),
    ).toHaveTextContent("placeholder rows");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("replaces the table when the read failed cold", () => {
    renderList({ data: undefined, error: { message: "Server error" } });

    expect(
      screen.getByText("Failed to load users. Server error"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("keeps the rows already read when only a revalidation failed", () => {
    renderList({ error: { message: "Server error" } });

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.queryByText(/Failed to load users/)).not.toBeInTheDocument();
  });

  it("shows the empty state once the read landed with no rows", () => {
    renderList({ data: { results: [] }, isEmpty: true });

    expect(screen.getByText("No users.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("waits for a read before showing the empty state", () => {
    renderList({ data: undefined, isEmpty: true });

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.queryByText("No users.")).not.toBeInTheDocument();
  });

  it("offers Retry on a cold failure", () => {
    const onRetry = vi.fn();
    renderList({
      data: undefined,
      error: { message: "Server error" },
      onRetry,
    });

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalled();
  });
});
