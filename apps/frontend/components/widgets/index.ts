import {
  Hash,
  AlignLeft,
  ImageIcon,
  CloudSun,
  ChartLine,
  ChartPie,
} from "lucide-react";
import { MetricWidget } from "./MetricWidget";
import { TextWidget } from "./TextWidget";
import { ImageWidget } from "./ImageWidget";
import { WeatherWidget } from "./WeatherWidget";
import { LineChartWidget } from "./LineChartWidget";
import { PieChartWidget } from "./PieChartWidget";

export {
  MetricWidget,
  TextWidget,
  ImageWidget,
  WeatherWidget,
  LineChartWidget,
  PieChartWidget,
};

export const widgetTypeIcon = {
  metric: Hash,
  text: AlignLeft,
  image: ImageIcon,
  weather: CloudSun,
  "line-chart": ChartLine,
  "pie-chart": ChartPie,
} as const;

export const widgetTypeComponent = {
  metric: MetricWidget,
  text: TextWidget,
  image: ImageWidget,
  weather: WeatherWidget,
  "line-chart": LineChartWidget,
  "pie-chart": PieChartWidget,
} as const;
