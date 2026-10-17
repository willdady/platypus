"use client";

import * as React from "react";
import * as RechartsPrimitive from "recharts";
import { cn } from "@/lib/utils";

export type ChartConfig = {
  [k in string]: {
    label?: React.ReactNode;
    color?: string;
  };
};

type ChartContextProps = { config: ChartConfig };

const ChartContext = React.createContext<ChartContextProps | null>(null);

function useChart() {
  const context = React.useContext(ChartContext);
  if (!context)
    throw new Error("useChart must be used within a ChartContainer");
  return context;
}

function ChartContainer({
  id,
  className,
  children,
  config,
  ...props
}: React.ComponentProps<"div"> & {
  config: ChartConfig;
  children: React.ComponentProps<
    typeof RechartsPrimitive.ResponsiveContainer
  >["children"];
}) {
  const uniqueId = React.useId();
  const chartId = `chart-${id ?? uniqueId.replace(/:/g, "")}`;

  return (
    <ChartContext.Provider value={{ config }}>
      <div
        data-slot="chart"
        data-chart={chartId}
        className={cn("flex aspect-video justify-center text-xs", className)}
        {...props}
      >
        <ChartStyle id={chartId} config={config} />
        <RechartsPrimitive.ResponsiveContainer>
          {children}
        </RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

function ChartStyle({ id, config }: { id: string; config: ChartConfig }) {
  const colorConfig = Object.entries(config).filter(([, cfg]) => cfg.color);
  if (!colorConfig.length) return null;
  return (
    <style
      dangerouslySetInnerHTML={{
        __html: colorConfig
          .map(
            ([key, cfg]) =>
              `[data-chart=${id}] { --color-${key}: ${cfg.color}; }`,
          )
          .join("\n"),
      }}
    />
  );
}

type TooltipPayloadItem = {
  dataKey?: string | number;
  value?: number | string | null;
  color?: string;
  name?: string;
};

const ChartTooltip = RechartsPrimitive.Tooltip;

function ChartTooltipContent({
  active,
  payload,
  className,
  label,
  labelFormatter,
  formatter,
  hideLabel = false,
}: React.ComponentProps<"div"> & {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  label?: string;
  labelFormatter?: (
    label: string,
    payload: TooltipPayloadItem[],
  ) => React.ReactNode;
  formatter?: (value: number, name: string) => React.ReactNode;
  hideLabel?: boolean;
}) {
  const { config } = useChart();

  if (!active || !payload?.length) return null;

  return (
    <div
      className={cn(
        "grid min-w-[8rem] items-start gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl",
        className,
      )}
    >
      {!hideLabel && label && (
        <div className="font-medium">
          {labelFormatter ? labelFormatter(label, payload) : label}
        </div>
      )}
      <div className="grid gap-1.5">
        {payload.map((item, idx) => {
          const key = String(item.dataKey ?? item.name ?? idx);
          const cfg = config[key];
          return (
            <div key={key} className="flex items-center gap-2">
              <div
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: item.color ?? cfg?.color }}
              />
              <span className="text-muted-foreground">{cfg?.label ?? key}</span>
              <span className="ml-auto font-medium tabular-nums">
                {formatter
                  ? formatter(item.value as number, key)
                  : (item.value as number)?.toLocaleString()}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const ChartLegend = RechartsPrimitive.Legend;

function ChartLegendContent({
  className,
  payload,
}: React.ComponentProps<"div"> & {
  payload?: Array<{ value: string; color?: string }>;
}) {
  const { config } = useChart();
  if (!payload?.length) return null;
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-center gap-4",
        className,
      )}
    >
      {payload.map((item) => {
        const cfg = config[item.value];
        return (
          <div key={item.value} className="flex items-center gap-1.5">
            <div
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: item.color ?? cfg?.color }}
            />
            <span className="text-muted-foreground text-xs">
              {cfg?.label ?? item.value}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
};
