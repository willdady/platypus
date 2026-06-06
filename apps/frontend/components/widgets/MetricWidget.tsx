"use client";

import { useState, useEffect, useRef } from "react";
import type { Widget } from "@platypus/schemas";
import { useResetOnChange } from "@/hooks/use-reset-on-change";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";

export function MetricWidget({
  widget,
  editing,
  onSave,
}: {
  widget: Widget;
  editing: boolean;
  onSave: (data: object, title: string) => void;
}) {
  const data = widget.data as
    | { value: number; label: string; unit?: string; change?: string }
    | null
    | undefined;
  const [title, setTitle] = useState(widget.title);
  const [value, setValue] = useState(String(data?.value ?? ""));
  const [label, setLabel] = useState(data?.label ?? "");
  const [unit, setUnit] = useState(data?.unit ?? "");
  const [change, setChange] = useState(data?.change ?? "");

  const fitContainerRef = useRef<HTMLDivElement>(null);
  const fitTextRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editing) return;
    const containerEl = fitContainerRef.current;
    const textEl = fitTextRef.current;
    if (!containerEl || !textEl) return;

    const fit = () => {
      textEl.style.fontSize = "";
      if (textEl.scrollWidth > containerEl.clientWidth) {
        const fs = parseFloat(getComputedStyle(textEl).fontSize);
        textEl.style.fontSize = `${fs * (containerEl.clientWidth / textEl.scrollWidth)}px`;
      }
    };

    const ro = new ResizeObserver(fit);
    ro.observe(containerEl);
    fit();
    return () => ro.disconnect();
  }, [data?.value, data?.unit, editing]);

  useResetOnChange(widget.title, () => setTitle(widget.title));
  useResetOnChange(String(widget.updatedAt), () => {
    setValue(String(data?.value ?? ""));
    setLabel(data?.label ?? "");
    setUnit(data?.unit ?? "");
    setChange(data?.change ?? "");
  });

  if (editing) {
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
            <Label className="text-xs">Value</Label>
            <Input
              type="number"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="h-7 text-sm"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Unit</Label>
            <Input
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              placeholder="%, $, …"
              className="h-7 text-sm"
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Label</Label>
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="h-7 text-sm"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Change indicator</Label>
          <Input
            value={change}
            onChange={(e) => setChange(e.target.value)}
            placeholder="+5% vs last week"
            className="h-7 text-sm"
          />
        </div>
        <Button
          size="sm"
          className="mt-auto"
          onClick={() =>
            onSave(
              {
                value: Number(value),
                label,
                ...(unit && { unit }),
                ...(change && { change }),
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

  return (
    <div
      className="flex flex-col justify-center items-start p-4 h-full"
      style={{ containerType: "size" }}
    >
      {data ? (
        <>
          <div ref={fitContainerRef} className="w-full">
            <div
              ref={fitTextRef}
              className="font-bold text-[60cqh] leading-none whitespace-nowrap inline-block"
            >
              {data.value}
              {data.unit && (
                <span
                  className={cn(
                    "font-normal",
                    ["°", "°C", "°F"].includes(data.unit)
                      ? "ml-[0.05em] text-[1em] align-top"
                      : "ml-[0.3em] text-[0.6em]",
                  )}
                >
                  {data.unit}
                </span>
              )}
            </div>
          </div>
          <div className="text-sm text-muted-foreground mt-1">{data.label}</div>
          {data.change && (
            <div className="text-xs text-muted-foreground mt-1">
              {data.change}
            </div>
          )}
        </>
      ) : (
        <p className="text-sm text-muted-foreground italic">No data yet</p>
      )}
    </div>
  );
}
