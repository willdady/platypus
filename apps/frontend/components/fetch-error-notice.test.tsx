import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FetchErrorNotice } from "./fetch-error-notice";

describe("FetchErrorNotice", () => {
  const noticeProps = {
    subject: "workspace",
    backHref: "/org1",
    backLabel: "Back to Organization",
  };

  it("offers a retry for a read that failed for any other reason", () => {
    const retry = vi.fn();
    render(
      <FetchErrorNotice
        {...noticeProps}
        error={{ status: 500 }}
        onRetry={retry}
      />,
    );

    expect(screen.getByText("Couldn't load")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  // Reading again won't bring back a deleted record or grant access.
  it.each([403, 404])("offers no retry for a %i", (status) => {
    render(
      <FetchErrorNotice
        {...noticeProps}
        error={{ status }}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(
      screen.getByRole("link", { name: "Back to Organization" }),
    ).toHaveAttribute("href", "/org1");
  });
});
