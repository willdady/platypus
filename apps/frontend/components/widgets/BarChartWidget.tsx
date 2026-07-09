"use client";

import { useState } from "react";
import { useResetOnChange } from "@/hooks/use-reset-on-change";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid } from "recharts";
import type { Widget, BarChartWidgetData } from "@platypus/schemas";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { genId, yAxisLabelContent } from "./chart-utils";
import { SeriesEditor, type SeriesEntry } from "./SeriesEditor";
import { CHART_COLORS } from "./chart-colors";

function toSeriesEntries(
  series: BarChartWidgetData["series"] | undefined,
): SeriesEntry[] {
  return (series ?? [{ label: "", values: [] }]).map((s) => ({
    id: genId(),
    ...s,
  }));
}

export function BarChartWidget({
  widget,
  editing,
  onSave,
}: {
  widget: Widget;
  editing: boolean;
  onSave: (data: object, title: string) => void;
}) {
  const data = widget.data as BarChartWidgetData | null | undefined;
  const [title, setTitle] = useState(widget.title);
  const [yAxisLabel, setYAxisLabel] = useState(data?.yAxisLabel ?? "");
  const [categoriesText, setCategoriesText] = useState(
    data?.categories.join(", ") ?? "",
  );
  const [series, setSeries] = useState<SeriesEntry[]>(() =>
    toSeriesEntries(data?.series),
  );

  useResetOnChange(widget.title, () => setTitle(widget.title));
  // updatedAt tracks server-side changes; array refs are not stable across renders
  useResetOnChange(String(widget.updatedAt), () => {
    setYAxisLabel(data?.yAxisLabel ?? "");
    setCategoriesText(data?.categories?.join(", ") ?? "");
    setSeries(toSeriesEntries(data?.series));
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
      { label: s.label, color: CHART_COLORS[i % CHART_COLORS.length] },
    ]),
  );

  const chartData = data.categories.map((category, i) => ({
    category,
    ...Object.fromEntries(data.series.map((s) => [s.label, s.values[i]])),
  }));

  const showLegend = data.series.length > 1;

  return (
    <ChartContainer
      config={chartConfig}
      className="h-full w-full aspect-auto pl-4 pr-2 pt-2 pb-1"
    >
      <BarChart
        data={chartData}
        accessibilityLayer
        margin={{ top: 4, right: 12, left: 0, bottom: 16 }}
      >
        <CartesianGrid
          vertical={false}
          stroke="var(--border)"
          strokeWidth={1}
        />
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
          width={data.yAxisLabel ? 72 : 40}
          label={
            data.yAxisLabel
              ? { content: yAxisLabelContent(data.yAxisLabel) }
              : undefined
          }
        />
        <ChartTooltip
          cursor={{ fill: "transparent" }}
          content={<ChartTooltipContent />}
        />
        {showLegend && <ChartLegend content={<ChartLegendContent />} />}
        {data.series.map((s, i) => (
          <Bar
            key={s.label}
            dataKey={s.label}
            fill={CHART_COLORS[i % CHART_COLORS.length]}
            radius={[4, 4, 0, 0]}
          />
        ))}
      </BarChart>
    </ChartContainer>
  );
}
