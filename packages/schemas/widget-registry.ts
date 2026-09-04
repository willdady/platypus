import { z } from "zod";

/**
 * The **Widget type registry**: the single source for what Widget types exist
 * and what is true of each one.
 *
 * Widget types used to be enumerated independently across the backend, this
 * package and the frontend, so adding one meant a spread of coordinated edits
 * and every omission failed quietly.
 *
 * The sharp end of that was `agentWritable`. The rule "an Agent updates Widget
 * data only, and never an Embed's URL" (CONTEXT.md, **Dashboard** and
 * **Widget**) used to hold because the agent tool's list of writable types was
 * never edited to include Embed — an omission, not a decision. A contributor
 * adding a type and dutifully updating every list they found would have
 * granted Agents write access to a human-owned type with nothing failing. Here
 * `agentWritable` is a required field with no default, so a new entry that
 * forgets to declare it is a compile error rather than a silent grant.
 *
 * Adding a Widget type is three edits: an entry below, a component entry in the
 * frontend's `widgetTypeUi` map, and the `widget.type` column's inline union in
 * the backend Drizzle schema. Omitting any of the three fails `pnpm typecheck`.
 *
 * Minimum sizes are deliberately NOT here: they stay sparse in the dashboard
 * page, where an absent type means "use the default".
 */

// Per-type data contracts. Each is the payload stored in `widget.data` for one
// Widget type; the registry below pairs each with its type string.

export const metricWidgetDataSchema = z.object({
  value: z.number(),
  label: z.string(),
  unit: z.string().optional(),
  change: z.string().optional(),
});

export type MetricWidgetData = z.infer<typeof metricWidgetDataSchema>;

export const textWidgetDataSchema = z.object({
  content: z.string(),
});

export type TextWidgetData = z.infer<typeof textWidgetDataSchema>;

export const imageWidgetDataSchema = z.object({
  url: z.string(),
});

export type ImageWidgetData = z.infer<typeof imageWidgetDataSchema>;

export const embedWidgetDataSchema = z
  .object({
    url: z
      .string()
      .url()
      .refine((url) => url.toLowerCase().startsWith("https://"), {
        message: "Embed URL must use HTTPS",
      }),
  })
  .strict();

export type EmbedWidgetData = z.infer<typeof embedWidgetDataSchema>;

export const weatherConditionSchema = z.enum([
  "clear-day",
  "clear-night",
  "partly-cloudy-day",
  "partly-cloudy-night",
  "cloudy",
  "rain",
  "sleet",
  "snow",
  "wind",
  "fog",
  "thunderstorm",
]);

export type WeatherCondition = z.infer<typeof weatherConditionSchema>;

export const weatherWidgetDataSchema = z.object({
  location: z.string(),
  date: z.string(),
  condition: weatherConditionSchema,
  description: z.string().max(100),
  temperatureC: z.number(),
  highC: z.number(),
  lowC: z.number(),
  unit: z.enum(["C", "F"]),
});

export type WeatherWidgetData = z.infer<typeof weatherWidgetDataSchema>;

export const lineChartSeriesSchema = z.object({
  label: z.string().describe("Series name shown in the legend"),
  values: z
    .array(z.number().nullable())
    .describe("One value per category; null renders as a gap in the line"),
});

export const lineChartWidgetDataSchema = z.object({
  yAxisLabel: z
    .string()
    .optional()
    .describe('Optional Y-axis label, e.g. "Revenue ($)"'),
  categories: z
    .array(z.string())
    .describe("X-axis category labels, one per data point"),
  series: z
    .array(lineChartSeriesSchema)
    .min(1)
    .describe("One or more data series; each becomes a line on the chart"),
});

export type LineChartWidgetData = z.infer<typeof lineChartWidgetDataSchema>;

export const pieChartSegmentSchema = z.object({
  label: z.string().describe("Segment name shown in the legend and tooltip"),
  value: z.number().describe("Absolute numeric value for this segment"),
});

export const pieChartWidgetDataSchema = z.object({
  centerLabel: z
    .string()
    .max(20)
    .optional()
    .describe(
      'Large text displayed in the donut hole, e.g. "$12,400" (max 20 chars)',
    ),
  centerSubLabel: z
    .string()
    .max(30)
    .optional()
    .describe('Smaller text below centerLabel, e.g. "Total" (max 30 chars)'),
  segments: z
    .array(pieChartSegmentSchema)
    .min(1)
    .describe("One or more segments making up the donut chart"),
});

export type PieChartWidgetData = z.infer<typeof pieChartWidgetDataSchema>;

export const barChartSeriesSchema = z.object({
  label: z.string().describe("Series name shown in the legend"),
  values: z
    .array(z.number().nullable())
    .describe("One value per category; null renders as a gap in the chart"),
});

export const barChartWidgetDataSchema = z.object({
  yAxisLabel: z
    .string()
    .optional()
    .describe('Optional Y-axis label, e.g. "Revenue ($)"'),
  categories: z
    .array(z.string())
    .describe("X-axis category labels, one per group of bars"),
  series: z
    .array(barChartSeriesSchema)
    .min(1)
    .describe("One or more data series; each becomes a set of bars"),
});

export type BarChartWidgetData = z.infer<typeof barChartWidgetDataSchema>;

/**
 * Everything the rest of the codebase needs to know about a Widget type.
 * Every field is required — in particular {@link WidgetTypeDefinition.agentWritable},
 * which must never gain a default.
 */
type WidgetTypeDefinition = {
  /** The name a User sees — in the add-widget picker and the docs. */
  label: string;
  /** The contract for this type's `widget.data` payload. */
  dataSchema: z.ZodType;
  /**
   * Whether an Agent may write this type's data through the `updateWidgetData`
   * tool. A deliberate decision per type, never a default: Embed is `false`
   * because its URL is configuration a User owns (#346), not content.
   */
  agentWritable: boolean;
  /** Grid units a freshly added Widget of this type occupies. */
  defaultSize: { w: number; h: number };
};

/**
 * `defaultSize` is in react-grid-layout units at rowHeight=30 — each `h` unit
 * is 30px plus a 10px margin, so `h: 5` is 190px. Every `h` must be >= 3, the
 * global minimum the dashboard grid enforces.
 */
export const widgetTypeRegistry = {
  metric: {
    label: "Metric",
    dataSchema: metricWidgetDataSchema,
    agentWritable: true,
    defaultSize: { w: 3, h: 5 },
  },
  text: {
    label: "Text / Markdown",
    dataSchema: textWidgetDataSchema,
    agentWritable: true,
    defaultSize: { w: 6, h: 7 },
  },
  image: {
    label: "Image",
    dataSchema: imageWidgetDataSchema,
    agentWritable: true,
    defaultSize: { w: 4, h: 7 },
  },
  embed: {
    label: "Embed",
    dataSchema: embedWidgetDataSchema,
    agentWritable: false,
    defaultSize: { w: 6, h: 8 },
  },
  weather: {
    label: "Weather",
    dataSchema: weatherWidgetDataSchema,
    agentWritable: true,
    defaultSize: { w: 2, h: 8 },
  },
  "line-chart": {
    label: "Line Chart",
    dataSchema: lineChartWidgetDataSchema,
    agentWritable: true,
    defaultSize: { w: 6, h: 8 },
  },
  "pie-chart": {
    label: "Pie Chart",
    dataSchema: pieChartWidgetDataSchema,
    agentWritable: true,
    defaultSize: { w: 4, h: 8 },
  },
  "bar-chart": {
    label: "Bar Chart",
    dataSchema: barChartWidgetDataSchema,
    agentWritable: true,
    defaultSize: { w: 6, h: 8 },
  },
} as const satisfies Record<string, WidgetTypeDefinition>;

/** The persisted `widget.type` string, one per registry key. */
export type WidgetType = keyof typeof widgetTypeRegistry;

/** The registry keys as a non-empty tuple, for the `z.enum` calls below. */
const widgetTypes = Object.keys(widgetTypeRegistry) as [
  WidgetType,
  ...WidgetType[],
];

/** The subset an Agent may write, derived rather than listed. */
export type AgentWritableWidgetType = {
  [
    K in WidgetType
  ]: (typeof widgetTypeRegistry)[K]["agentWritable"] extends true ? K : never;
}[WidgetType];

const agentWritableWidgetTypes = widgetTypes.filter(
  (type) => widgetTypeRegistry[type].agentWritable,
) as [AgentWritableWidgetType, ...AgentWritableWidgetType[]];

export const widgetTypeSchema = z.enum(widgetTypes);

/**
 * `z.discriminatedUnion` and `z.union` need a non-empty tuple, which `.map`
 * cannot produce. The only cast the derivation needs, contained in this module.
 */
function nonEmpty<T>(items: T[]): [T, ...T[]] {
  return items as [T, ...T[]];
}

/**
 * Builds one union member per registry entry, in registry order. Mapping over
 * the registry erases the key/value correlation it holds, so these members are
 * correlated only by construction — the exported {@link Widget} type below is
 * rebuilt from the registry with a mapped type so no narrowing is lost.
 */
function unionMembers<T extends z.ZodType>(
  member: (type: WidgetType, dataSchema: z.ZodType) => T,
): [T, ...T[]] {
  return nonEmpty(
    widgetTypes.map((type) =>
      member(type, widgetTypeRegistry[type].dataSchema),
    ),
  );
}

export const widgetDataSchema = z.discriminatedUnion(
  "type",
  unionMembers((type, dataSchema) =>
    z.object({ type: z.literal(type), data: dataSchema }),
  ),
);

const widgetBaseSchema = z.object({
  id: z.string(),
  dashboardId: z.string(),
  title: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

// Keep each persisted widget type paired with its own data contract. A plain
// data union can let a permissive schema shadow a stricter schema with the same shape.
export const widgetSchema = z.discriminatedUnion(
  "type",
  unionMembers((type, dataSchema) =>
    widgetBaseSchema.extend({
      type: z.literal(type),
      data: dataSchema.nullable(),
    }),
  ),
);

/**
 * Rebuilt from the registry rather than inferred from {@link widgetSchema}:
 * the runtime union is assembled by a `.map`, which erases the pairing between
 * a type string and its data shape. This mapped type keeps `Widget` a true
 * discriminated union, so assigning a Metric's data to an `embed` Widget stays
 * a type error.
 */
export type Widget = {
  [K in WidgetType]: z.infer<typeof widgetBaseSchema> & {
    type: K;
    data: z.infer<(typeof widgetTypeRegistry)[K]["dataSchema"]> | null;
  };
}[WidgetType];

export const widgetCreateSchema = z.object({
  type: widgetTypeSchema,
  title: z.string().min(1).max(200),
});

export const widgetUpdateDataSchema = z.discriminatedUnion(
  "type",
  unionMembers((type, dataSchema) =>
    z.object({
      type: z.literal(type),
      title: z.string().min(1).max(200).optional(),
      data: dataSchema,
    }),
  ),
);

/**
 * The Agent-facing half of the registry, for the `updateWidgetData` tool. A
 * type absent from {@link agentWritableWidgetTypes} is rejected by the tool's
 * input schema before any handler runs.
 */
export const agentWritableWidgetTypeSchema = z.enum(agentWritableWidgetTypes);

export const agentWritableWidgetDataSchema = z.union(
  nonEmpty(
    agentWritableWidgetTypes.map((type) => widgetTypeRegistry[type].dataSchema),
  ),
);
