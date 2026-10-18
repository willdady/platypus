import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import DashboardsLayout from "./layout";

// The layout wraps every Dashboards route (detail, create, settings), so the
// banner rendering here is it rendering on each of them.
describe("DashboardsLayout", () => {
  it("shows the v4.0.0 deprecation banner above the page", () => {
    render(
      <DashboardsLayout>
        <p>Dashboard page</p>
      </DashboardsLayout>,
    );

    const banner = screen.getByRole("alert");
    expect(banner).toHaveTextContent("Dashboards are deprecated");
    expect(banner).toHaveTextContent("v4.0.0");
    for (const tool of ["listDashboards", "listWidgets", "updateWidgetData"]) {
      expect(banner).toHaveTextContent(tool);
    }
    expect(screen.getByText("Dashboard page")).toBeInTheDocument();
  });
});
