"use client";

import { useState } from "react";
import { useResetOnChange } from "@/hooks/use-reset-on-change";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import type {
  Widget,
  BarChartWidgetData,
  LineChartWidgetData,
} from "@platypus/schemas";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { toEditorEntries, yAxisLabelContent } from "./chart-utils";
import { colorForIndex } from "./chart-colors";
import { SeriesEditor, type SeriesEntry } from "./SeriesEditor";

type CartesianChartWidgetData = BarChartWidgetData | LineChartWidgetData;

/**
 * The one component behind both cartesian Widget types. Bar and line share
 * their data contract, editor, axes, and legend; they differ only in the chart
 * root, the series element, the tooltip cursor, and the Y-axis width.
 */
export function CartesianChartWidget({
  widget,
  editing,
  onSave,
}: {
  widget: Widget;
  editing: boolean;
  onSave: (data: object, title: string) => void;
}) {
  const isBar = widget.type === "bar-chart";
  const data = widget.data as CartesianChartWidgetData | null | undefined;
  const [title, setTitle] = useState(widget.title);
  const [yAxisLabel, setYAxisLabel] = useState(data?.yAxisLabel ?? "");
  const [categoriesText, setCategoriesText] = useState(
    data?.categories.join(", ") ?? "",
  );
  const [series, setSeries] = useState<SeriesEntry[]>(() =>
    toEditorEntries(data?.series, { label: "", values: [] }),
  );

  useResetOnChange(widget.title, () => setTitle(widget.title));
  // updatedAt tracks server-side changes; array refs are not stable across renders
  useResetOnChange(String(widget.updatedAt), () => {
    setYAxisLabel(data?.yAxisLabel ?? "");
    setCategoriesText(data?.categories?.join(", ") ?? "");
    setSeries(toEditorEntries(data?.series, { label: "", values: [] }));
  });

  if (editing) {
    return (
      <SeriesEditor
        title={title}
        onTitleChange={setTitle}
        yAxisLabel={yAxisLabel}
        onYAxisLabelChange={setYAxisLabel}
        categoriesText={categoriesText}
        onCategoriesTextChange={setCategoriesText}
        series={series}
        onSeriesChange={setSeries}
        onSave={() => {
          const categories = categoriesText
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean);
          onSave(
            {
              ...(yAxisLabel ? { yAxisLabel } : {}),
              categories,
              series: series.map(({ label, values }) => ({ label, values })),
            },
            title,
          );
        }}
      />
    );
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-muted-foreground italic">No data yet</p>
      </div>
    );
  }

  const chartConfig: ChartConfig = Object.fromEntries(
    data.series.map((s, i) => [
      s.label,
      { label: s.label, color: colorForIndex(i) },
    ]),
  );

  const chartData = data.categories.map((category, i) => ({
    category,
    ...Object.fromEntries(data.series.map((s) => [s.label, s.values[i]])),
  }));

  const showLegend = data.series.length > 1;

  const axes = (
    <>
      <CartesianGrid vertical={false} stroke="var(--border)" strokeWidth={1} />
      <XAxis
        dataKey="category"
        tickLine={false}
        axisLine={false}
        tickMargin={8}
        padding={{ left: 0, right: 20 }}
      />
      <YAxis
        tickLine={false}
        axisLine={false}
        tickMargin={8}
        width={data.yAxisLabel ? (isBar ? 72 : 56) : 40}
        label={
          data.yAxisLabel
            ? { content: yAxisLabelContent(data.yAxisLabel) }
            : undefined
        }
      />
      <ChartTooltip
        cursor={isBar ? { fill: "transparent" } : undefined}
        content={<ChartTooltipContent />}
      />
      {showLegend && <ChartLegend content={<ChartLegendContent />} />}
    </>
  );

  return (
    <ChartContainer
      config={chartConfig}
      className="h-full w-full aspect-auto pl-4 pr-2 pt-2 pb-1"
    >
      {isBar ? (
        <BarChart
          data={chartData}
          accessibilityLayer
          margin={{ top: 4, right: 12, left: 0, bottom: 16 }}
        >
          {axes}
          {data.series.map((s, i) => (
            <Bar
              key={s.label}
              dataKey={s.label}
              fill={colorForIndex(i)}
              radius={[4, 4, 0, 0]}
            />
          ))}
        </BarChart>
      ) : (
        <LineChart
          data={chartData}
          accessibilityLayer
          margin={{ top: 4, right: 12, left: 0, bottom: 16 }}
        >
          {axes}
          {data.series.map((s, i) => (
            <Line
              key={s.label}
              dataKey={s.label}
              type="monotone"
              stroke={colorForIndex(i)}
              strokeWidth={2}
              dot={false}
              connectNulls={false}
            />
          ))}
        </LineChart>
      )}
    </ChartContainer>
  );
}
