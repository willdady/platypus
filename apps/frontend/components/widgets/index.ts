import {
  Hash,
  AlignLeft,
  ImageIcon,
  AppWindow,
  CloudSun,
  ChartLine,
  ChartPie,
  ChartColumnIncreasing,
} from "lucide-react";
import { MetricWidget } from "./MetricWidget";
import { TextWidget } from "./TextWidget";
import { ImageWidget } from "./ImageWidget";
import { IframeWidget } from "./IframeWidget";
import { WeatherWidget } from "./WeatherWidget";
import { LineChartWidget } from "./LineChartWidget";
import { PieChartWidget } from "./PieChartWidget";
import { BarChartWidget } from "./BarChartWidget";

export {
  MetricWidget,
  TextWidget,
  ImageWidget,
  IframeWidget,
  WeatherWidget,
  LineChartWidget,
  PieChartWidget,
  BarChartWidget,
};

export const widgetTypeIcon = {
  metric: Hash,
  text: AlignLeft,
  image: ImageIcon,
  iframe: AppWindow,
  weather: CloudSun,
  "line-chart": ChartLine,
  "pie-chart": ChartPie,
  "bar-chart": ChartColumnIncreasing,
} as const;

export const widgetTypeComponent = {
  metric: MetricWidget,
  text: TextWidget,
  image: ImageWidget,
  iframe: IframeWidget,
  weather: WeatherWidget,
  "line-chart": LineChartWidget,
  "pie-chart": PieChartWidget,
  "bar-chart": BarChartWidget,
} as const;
