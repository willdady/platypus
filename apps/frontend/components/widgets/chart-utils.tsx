export const genId = () => Math.random().toString(36).slice(2, 9);

/**
 * Seeds an editor's local rows from persisted data. Each row is given a stable
 * client-only `id` so it can be reordered/removed before it is ever saved. The
 * fallback keeps an empty row for a widget that has no data yet.
 */
export function toEditorEntries<T extends object>(
  items: T[] | undefined,
  fallback: T,
): (T & { id: string })[] {
  return (items ?? [fallback]).map((item) => ({ id: genId(), ...item }));
}

export function seriesValuesToText(values: (number | null)[]): string {
  return values.map((v) => (v === null ? "" : String(v))).join(", ");
}

export function textToSeriesValues(text: string): (number | null)[] {
  return text.split(",").map((v) => {
    const trimmed = v.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    return isNaN(n) ? null : n;
  });
}

export function yAxisLabelContent(label: string) {
  const YAxisLabel = ({ viewBox }: { viewBox?: object }) => {
    if (!viewBox || !("x" in viewBox)) return null;
    const { x, y, height } = viewBox as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    return (
      <text
        transform={`translate(${x + 8},${y + height / 2}) rotate(-90)`}
        textAnchor="middle"
        fontSize={12}
        fill="var(--muted-foreground)"
      >
        {label}
      </text>
    );
  };
  return YAxisLabel;
}
