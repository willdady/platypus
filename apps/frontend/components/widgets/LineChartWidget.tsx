"use client";

import { useState, useEffect } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid } from "recharts";
import type { Widget, LineChartWidgetData } from "@platypus/schemas";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Check, Plus, X } from "lucide-react";
import { CHART_COLORS } from "./chart-colors";

function seriesValuesToText(values: (number | null)[]): string {
  return values.map((v) => (v === null ? "" : String(v))).join(", ");
}

function textToSeriesValues(text: string): (number | null)[] {
  return text.split(",").map((v) => {
    const trimmed = v.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    return isNaN(n) ? null : n;
  });
}

export function LineChartWidget({
  widget,
  editing,
  onSave,
}: {
  widget: Widget;
  editing?: boolean;
  onSave?: (data: object, title: string) => void;
}) {
  const data = widget.data as LineChartWidgetData | null | undefined;
  const [title, setTitle] = useState(widget.title);
  const [yAxisLabel, setYAxisLabel] = useState(data?.yAxisLabel ?? "");
  const [categoriesText, setCategoriesText] = useState(
    data?.categories.join(", ") ?? "",
  );
  const [series, setSeries] = useState(
    data?.series ?? [{ label: "", values: [] as (number | null)[] }],
  );

  useEffect(() => {
    setTitle(widget.title);
  }, [widget.title]);

  useEffect(() => {
    setYAxisLabel(data?.yAxisLabel ?? "");
    setCategoriesText(data?.categories.join(", ") ?? "");
    setSeries(data?.series ?? [{ label: "", values: [] }]);
  }, [data?.yAxisLabel, data?.categories, data?.series]);

  if (editing) {
    const handleAddSeries = () =>
      setSeries((prev) => [...prev, { label: "", values: [] }]);

    const handleRemoveSeries = (i: number) =>
      setSeries((prev) => prev.filter((_, idx) => idx !== i));

    const handleSave = () => {
      if (!onSave) return;
      const categories = categoriesText
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);
      onSave(
        {
          ...(yAxisLabel ? { yAxisLabel } : {}),
          categories,
          series: series.map((s) => ({ label: s.label, values: s.values })),
        },
        title,
      );
    };

    return (
      <div className="flex flex-col gap-2 p-3 h-full overflow-auto">
        <div className="space-y-1">
          <Label className="text-xs">Name</Label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="h-7 text-sm"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Y-axis label (optional)</Label>
          <Input
            value={yAxisLabel}
            onChange={(e) => setYAxisLabel(e.target.value)}
            placeholder="Revenue ($)"
            className="h-7 text-sm"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Categories (comma-separated)</Label>
          <Input
            value={categoriesText}
            onChange={(e) => setCategoriesText(e.target.value)}
            placeholder="Jan, Feb, Mar"
            className="h-7 text-sm"
          />
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs">Series</Label>
            <button
              onClick={handleAddSeries}
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-0.5"
            >
              <Plus className="h-3 w-3" /> Add series
            </button>
          </div>
          {series.map((s, i) => (
            <div key={i} className="space-y-1 rounded border p-2">
              <div className="flex items-center gap-1">
                <div
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{
                    backgroundColor: CHART_COLORS[i % CHART_COLORS.length],
                  }}
                />
                <Input
                  value={s.label}
                  onChange={(e) =>
                    setSeries((prev) =>
                      prev.map((item, idx) =>
                        idx === i ? { ...item, label: e.target.value } : item,
                      ),
                    )
                  }
                  placeholder="Series label"
                  className="h-6 text-xs flex-1"
                />
                {series.length > 1 && (
                  <button
                    onClick={() => handleRemoveSeries(i)}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
              <Input
                value={seriesValuesToText(s.values)}
                onChange={(e) =>
                  setSeries((prev) =>
                    prev.map((item, idx) =>
                      idx === i
                        ? {
                            ...item,
                            values: textToSeriesValues(e.target.value),
                          }
                        : item,
                    ),
                  )
                }
                placeholder="100, 200, , 150  (blank = gap)"
                className="h-6 text-xs font-mono"
              />
            </div>
          ))}
        </div>
        <Button size="sm" className="mt-auto" onClick={handleSave}>
          <Check className="h-3 w-3" /> Save
        </Button>
      </div>
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
      className="h-full w-full aspect-auto px-2 pt-2 pb-1"
    >
      <LineChart
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
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          width={data.yAxisLabel ? 60 : 40}
          label={
            data.yAxisLabel
              ? {
                  value: data.yAxisLabel,
                  angle: -90,
                  position: "insideLeft",
                  offset: 10,
                  style: { textAnchor: "middle" },
                }
              : undefined
          }
        />
        <ChartTooltip content={<ChartTooltipContent />} />
        {showLegend && <ChartLegend content={<ChartLegendContent />} />}
        {data.series.map((s, i) => (
          <Line
            key={s.label}
            dataKey={s.label}
            type="monotone"
            stroke={CHART_COLORS[i % CHART_COLORS.length]}
            strokeWidth={2}
            dot={false}
            connectNulls={false}
          />
        ))}
      </LineChart>
    </ChartContainer>
  );
}
