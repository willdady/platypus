import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ListError, ListState } from "./list-state";

describe("ListState", () => {
  it("renders empty copy in the muted tone", () => {
    render(<ListState variant="empty">No blueprints yet.</ListState>);

    expect(screen.getByText("No blueprints yet.")).toHaveClass(
      "text-muted-foreground",
    );
  });

  it("renders an error in the destructive tone", () => {
    render(<ListState variant="error">Failed to load agents.</ListState>);

    expect(screen.getByText("Failed to load agents.")).toHaveClass(
      "text-destructive",
    );
  });
});

describe("ListError", () => {
  it("names the subject and prefers the response body's error", () => {
    render(
      <ListError
        error={{
          message: "An error occurred while fetching the data.",
          info: { error: "Server exploded" },
        }}
        subject="providers"
      />,
    );

    expect(
      screen.getByText("Failed to load providers. Server exploded"),
    ).toBeInTheDocument();
  });

  // A validation failure's body carries an object under `error`.
  it("falls back to the error's own message when the body's error isn't text", () => {
    render(
      <ListError
        error={{ message: "Bad query", info: { error: { issues: [] } } }}
        subject="agents"
      />,
    );

    expect(
      screen.getByText("Failed to load agents. Bad query"),
    ).toBeInTheDocument();
  });

  it("falls back to the error's own message", () => {
    render(<ListError error={{ message: "Network down" }} subject="users" />);

    expect(
      screen.getByText("Failed to load users. Network down"),
    ).toBeInTheDocument();
  });
});
