"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Check, Plus, X } from "lucide-react";
import { colorForIndex } from "./chart-colors";
import { genId, seriesValuesToText, textToSeriesValues } from "./chart-utils";

export interface SeriesEntry {
  id: string;
  label: string;
  values: (number | null)[];
}

interface Props {
  title: string;
  onTitleChange: (v: string) => void;
  yAxisLabel: string;
  onYAxisLabelChange: (v: string) => void;
  categoriesText: string;
  onCategoriesTextChange: (v: string) => void;
  series: SeriesEntry[];
  onSeriesChange: (s: SeriesEntry[]) => void;
  onSave: () => void;
}

export function SeriesEditor({
  title,
  onTitleChange,
  yAxisLabel,
  onYAxisLabelChange,
  categoriesText,
  onCategoriesTextChange,
  series,
  onSeriesChange,
  onSave,
}: Props) {
  const handleAddSeries = () =>
    onSeriesChange([...series, { id: genId(), label: "", values: [] }]);

  const handleRemoveSeries = (id: string) =>
    onSeriesChange(series.filter((s) => s.id !== id));

  return (
    <div className="flex flex-col gap-2 p-3 h-full overflow-auto">
      <div className="space-y-1">
        <Label className="text-xs">Name</Label>
        <Input
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          className="h-7 text-sm"
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Y-axis label (optional)</Label>
        <Input
          value={yAxisLabel}
          onChange={(e) => onYAxisLabelChange(e.target.value)}
          placeholder="Revenue ($)"
          className="h-7 text-sm"
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Categories (comma-separated)</Label>
        <Input
          value={categoriesText}
          onChange={(e) => onCategoriesTextChange(e.target.value)}
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
          <div key={s.id} className="space-y-1 rounded border p-2">
            <div className="flex items-center gap-1">
              <div
                className="h-2 w-2 shrink-0 rounded-full"
                style={{
                  backgroundColor: colorForIndex(i),
                }}
              />
              <Input
                value={s.label}
                onChange={(e) =>
                  onSeriesChange(
                    series.map((item) =>
                      item.id === s.id
                        ? { ...item, label: e.target.value }
                        : item,
                    ),
                  )
                }
                placeholder="Series label"
                className="h-6 text-xs flex-1"
              />
              {series.length > 1 && (
                <button
                  onClick={() => handleRemoveSeries(s.id)}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
            <Input
              value={seriesValuesToText(s.values)}
              onChange={(e) =>
                onSeriesChange(
                  series.map((item) =>
                    item.id === s.id
                      ? { ...item, values: textToSeriesValues(e.target.value) }
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
      <Button size="sm" className="mt-auto" onClick={onSave}>
        <Check className="h-3 w-3" /> Save
      </Button>
    </div>
  );
}
