import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Widget } from "@platypus/schemas";
import { CartesianChartWidget } from "./CartesianChartWidget";

// jsdom gives ResponsiveContainer no layout, so it would render nothing. Hand
// the chart a fixed box instead of its measured one; everything below this
// still exercises the real recharts tree.
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  const React = await import("react");
  return {
    ...actual,
    ResponsiveContainer: ({
      children,
    }: {
      children: React.ReactElement<{ width?: number; height?: number }>;
    }) => React.cloneElement(children, { width: 400, height: 300 }),
  };
});

const base = {
  dashboardId: "dashboard-1",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const barWidget: Widget = {
  ...base,
  id: "widget-bar",
  type: "bar-chart",
  title: "Revenue",
  data: {
    yAxisLabel: "Revenue ($)",
    categories: ["Jan", "Feb"],
    series: [{ label: "2025", values: [10, 20] }],
  },
};

const lineWidget: Widget = {
  ...base,
  id: "widget-line",
  type: "line-chart",
  title: "Visits",
  data: {
    categories: ["Jan", "Feb"],
    series: [{ label: "2025", values: [10, 20] }],
  },
};

describe("CartesianChartWidget", () => {
  it("renders a bar series for a bar-chart widget", () => {
    const { container } = render(
      <CartesianChartWidget
        widget={barWidget}
        editing={false}
        onSave={vi.fn()}
      />,
    );

    expect(container.querySelector(".recharts-bar")).toBeInTheDocument();
    expect(container.querySelector(".recharts-line")).not.toBeInTheDocument();
  });

  it("renders a line series for a line-chart widget", () => {
    const { container } = render(
      <CartesianChartWidget
        widget={lineWidget}
        editing={false}
        onSave={vi.fn()}
      />,
    );

    expect(container.querySelector(".recharts-line")).toBeInTheDocument();
    expect(container.querySelector(".recharts-bar")).not.toBeInTheDocument();
  });

  it("shows the empty state when there is no data", () => {
    render(
      <CartesianChartWidget
        widget={{ ...lineWidget, data: null }}
        editing={false}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByText("No data yet")).toBeInTheDocument();
  });

  it.each([
    ["bar-chart", barWidget, { yAxisLabel: "Revenue ($)" }],
    ["line-chart", lineWidget, {}],
  ] as const)(
    "edits and saves a %s widget through the shared series editor",
    (_type, widget, extra) => {
      const onSave = vi.fn();
      render(
        <CartesianChartWidget widget={widget} editing={true} onSave={onSave} />,
      );

      fireEvent.change(screen.getByDisplayValue(widget.title), {
        target: { value: "Renamed" },
      });
      fireEvent.change(screen.getByDisplayValue("Jan, Feb"), {
        target: { value: "Q1, Q2" },
      });
      fireEvent.click(screen.getByRole("button", { name: /save/i }));

      expect(onSave).toHaveBeenCalledWith(
        {
          ...extra,
          categories: ["Q1", "Q2"],
          series: [{ label: "2025", values: [10, 20] }],
        },
        "Renamed",
      );
    },
  );
});
