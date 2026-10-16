import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { setErrorReporter } from "@/lib/error-reporting";

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgId: "org1", workspaceId: "ws1" }),
}));

import { RouteError } from "./route-error";
import { WorkspaceNotFound } from "./workspace-not-found";
import { OrgSettingsNotFound } from "./org-settings-not-found";

afterEach(() => setErrorReporter(null));

describe("RouteError", () => {
  it("says the page couldn't load and offers to try again", () => {
    const retry = vi.fn();
    render(
      <RouteError error={new Error("boom")} retry={retry} source="segment" />,
    );

    expect(screen.getByText("Couldn't load this page")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalled();
  });

  it("hands the error to the error reporter, with its digest", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reporter = vi.fn();
    setErrorReporter(reporter);
    const error = Object.assign(new Error("boom"), { digest: "d1" });

    render(<RouteError error={error} retry={vi.fn()} source="segment" />);

    expect(reporter).toHaveBeenCalledWith(error, {
      source: "segment",
      digest: "d1",
    });
  });
});

describe("WorkspaceNotFound", () => {
  it("says the workspace is gone and links back to its organization", () => {
    render(<WorkspaceNotFound />);

    expect(screen.getByText("Workspace not found")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Back to Organization" }),
    ).toHaveAttribute("href", "/org1");
  });
});

describe("OrgSettingsNotFound", () => {
  it("says the settings page is gone and links back to the settings", () => {
    render(<OrgSettingsNotFound />);

    expect(screen.getByText("Page not found")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Back to settings" }),
    ).toHaveAttribute("href", "/org1/settings");
  });
});
