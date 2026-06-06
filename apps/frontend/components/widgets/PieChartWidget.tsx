"use client";

import { useState } from "react";
import { useResetOnChange } from "@/hooks/use-reset-on-change";
import { Pie, PieChart, Cell, Label as RechartsLabel } from "recharts";
import type { Widget, PieChartWidgetData } from "@platypus/schemas";
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
import { genId } from "./chart-utils";
import { CHART_COLORS } from "./chart-colors";

interface SegmentEntry {
  id: string;
  label: string;
  value: number;
}

function toSegmentEntries(
  segments: PieChartWidgetData["segments"] | undefined,
): SegmentEntry[] {
  return (segments ?? [{ label: "", value: 0 }]).map((s) => ({
    id: genId(),
    ...s,
  }));
}

export function PieChartWidget({
  widget,
  editing,
  onSave,
}: {
  widget: Widget;
  editing: boolean;
  onSave: (data: object, title: string) => void;
}) {
  const data = widget.data as PieChartWidgetData | null | undefined;
  const [title, setTitle] = useState(widget.title);
  const [centerLabel, setCenterLabel] = useState(data?.centerLabel ?? "");
  const [centerSubLabel, setCenterSubLabel] = useState(
    data?.centerSubLabel ?? "",
  );
  const [segments, setSegments] = useState<SegmentEntry[]>(() =>
    toSegmentEntries(data?.segments),
  );

  useResetOnChange(widget.title, () => setTitle(widget.title));
  // updatedAt tracks server-side changes; array refs are not stable across renders
  useResetOnChange(String(widget.updatedAt), () => {
    setCenterLabel(data?.centerLabel ?? "");
    setCenterSubLabel(data?.centerSubLabel ?? "");
    setSegments(toSegmentEntries(data?.segments));
  });

  if (editing) {
    const handleAddSegment = () =>
      setSegments((prev) => [...prev, { id: genId(), label: "", value: 0 }]);

    const handleRemoveSegment = (id: string) =>
      setSegments((prev) => prev.filter((s) => s.id !== id));

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
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-xs">Center label (optional)</Label>
            <Input
              value={centerLabel}
              onChange={(e) => setCenterLabel(e.target.value)}
              placeholder="$12,400"
              maxLength={20}
              className="h-7 text-sm"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Center sub-label (optional)</Label>
            <Input
              value={centerSubLabel}
              onChange={(e) => setCenterSubLabel(e.target.value)}
              placeholder="Total"
              maxLength={30}
              className="h-7 text-sm"
            />
          </div>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs">Segments</Label>
            <button
              onClick={handleAddSegment}
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-0.5"
            >
              <Plus className="h-3 w-3" /> Add segment
            </button>
          </div>
          {segments.map((s, i) => (
            <div key={s.id} className="flex items-center gap-1.5">
              <div
                className="h-2 w-2 shrink-0 rounded-full"
                style={{
                  backgroundColor: CHART_COLORS[i % CHART_COLORS.length],
                }}
              />
              <Input
                value={s.label}
                onChange={(e) =>
                  setSegments((prev) =>
                    prev.map((item) =>
                      item.id === s.id
                        ? { ...item, label: e.target.value }
                        : item,
                    ),
                  )
                }
                placeholder="Label"
                className="h-6 text-xs flex-1"
              />
              <Input
                type="number"
                value={s.value}
                onChange={(e) =>
                  setSegments((prev) =>
                    prev.map((item) =>
                      item.id === s.id
                        ? { ...item, value: Number(e.target.value) }
                        : item,
                    ),
                  )
                }
                placeholder="Value"
                className="h-6 text-xs w-24"
              />
              {segments.length > 1 && (
                <button
                  onClick={() => handleRemoveSegment(s.id)}
                  className="text-muted-foreground hover:text-destructive shrink-0"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}
        </div>
        <Button
          size="sm"
          className="mt-auto"
          onClick={() =>
            onSave(
              {
                ...(centerLabel ? { centerLabel } : {}),
                ...(centerSubLabel ? { centerSubLabel } : {}),
                segments: segments.map(({ label, value }) => ({
                  label,
                  value,
                })),
              },
              title,
            )
          }
        >
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
    data.segments.map((s, i) => [
      s.label,
      { label: s.label, color: CHART_COLORS[i % CHART_COLORS.length] },
    ]),
  );

  return (
    <ChartContainer
      config={chartConfig}
      className="h-full w-full aspect-auto px-2 pt-2 pb-1"
    >
      <PieChart>
        <ChartTooltip content={<ChartTooltipContent />} />
        <Pie
          data={data.segments}
          dataKey="value"
          nameKey="label"
          innerRadius="55%"
          outerRadius="80%"
          paddingAngle={2}
          stroke="none"
        >
          {data.segments.map((s, i) => (
            <Cell key={s.label} fill={CHART_COLORS[i % CHART_COLORS.length]} />
          ))}
          {(data.centerLabel || data.centerSubLabel) && (
            <RechartsLabel
              content={({ viewBox }) => {
                if (!viewBox || !("cx" in viewBox) || !("cy" in viewBox))
                  return null;
                const { cx, cy } = viewBox as { cx: number; cy: number };
                return (
                  <text
                    x={cx}
                    y={cy}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fill="var(--foreground)"
                  >
                    {data.centerLabel && (
                      <tspan
                        x={cx}
                        dy={data.centerSubLabel ? "-0.5em" : "0"}
                        fontSize={20}
                        fontWeight="bold"
                      >
                        {data.centerLabel}
                      </tspan>
                    )}
                    {data.centerSubLabel && (
                      <tspan
                        x={cx}
                        dy={data.centerLabel ? "1.4em" : "0"}
                        fontSize={12}
                        fill="var(--muted-foreground)"
                      >
                        {data.centerSubLabel}
                      </tspan>
                    )}
                  </text>
                );
              }}
            />
          )}
        </Pie>
        <ChartLegend content={<ChartLegendContent />} />
      </PieChart>
    </ChartContainer>
  );
}
