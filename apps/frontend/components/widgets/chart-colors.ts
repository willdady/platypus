export const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

/** Cycles the palette so a series or segment keeps one colour as it is added. */
export const colorForIndex = (index: number) =>
  CHART_COLORS[index % CHART_COLORS.length];
