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

  it.each([403, 404])("offers no retry for a %i", (status) => {
    render(
      <FetchErrorNotice
        {...noticeProps}
        error={{ status }}
        onRetry={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Retry" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Back to Organization" }),
    ).toHaveAttribute("href", "/org1");
  });

  it("uses a caller's description in place of the default one", () => {
    render(
      <FetchErrorNotice
        {...noticeProps}
        error={{ status: 500 }}
        description="It may have been pruned by the trigger's Max Runs to Keep."
      />,
    );

    expect(
      screen.getByText(
        "It may have been pruned by the trigger's Max Runs to Keep.",
      ),
    ).toBeInTheDocument();
  });
});
