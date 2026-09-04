import type { ComponentType } from "react";
import {
  Hash,
  AlignLeft,
  ImageIcon,
  AppWindow,
  CloudSun,
  ChartLine,
  ChartPie,
  ChartColumnIncreasing,
  type LucideIcon,
} from "lucide-react";
import type { Widget, WidgetType } from "@platypus/schemas";
import { MetricWidget } from "./MetricWidget";
import { TextWidget } from "./TextWidget";
import { ImageWidget } from "./ImageWidget";
import { EmbedWidget } from "./EmbedWidget";
import { WeatherWidget } from "./WeatherWidget";
import { LineChartWidget } from "./LineChartWidget";
import { PieChartWidget } from "./PieChartWidget";
import { BarChartWidget } from "./BarChartWidget";

export {
  MetricWidget,
  TextWidget,
  ImageWidget,
  EmbedWidget,
  WeatherWidget,
  LineChartWidget,
  PieChartWidget,
  BarChartWidget,
};

type WidgetComponent = ComponentType<{
  widget: Widget;
  editing: boolean;
  onSave: (data: object, title: string) => void;
}>;

/**
 * The half of a widget type that cannot live in `@platypus/schemas` — that
 * package must not depend on React, and both an icon and a component are React
 * values. Total over {@link WidgetType}, so a type added to the registry with
 * no entry here fails `pnpm typecheck` rather than rendering as an empty tile.
 */
export const widgetTypeUi: Record<
  WidgetType,
  { icon: LucideIcon; component: WidgetComponent }
> = {
  metric: { icon: Hash, component: MetricWidget },
  text: { icon: AlignLeft, component: TextWidget },
  image: { icon: ImageIcon, component: ImageWidget },
  embed: { icon: AppWindow, component: EmbedWidget },
  weather: { icon: CloudSun, component: WeatherWidget },
  "line-chart": { icon: ChartLine, component: LineChartWidget },
  "pie-chart": { icon: ChartPie, component: PieChartWidget },
  "bar-chart": { icon: ChartColumnIncreasing, component: BarChartWidget },
};
