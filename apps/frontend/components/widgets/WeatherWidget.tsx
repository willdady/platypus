"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import type {
  Widget,
  WeatherWidgetData,
  WeatherCondition,
} from "@platypus/schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Check } from "lucide-react";

const weatherConditionIcon: Record<WeatherCondition, string> = {
  "clear-day": "/weather/clear-day.svg",
  "clear-night": "/weather/clear-night.svg",
  "partly-cloudy-day": "/weather/partly-cloudy-day.svg",
  "partly-cloudy-night": "/weather/partly-cloudy-night.svg",
  cloudy: "/weather/cloudy.svg",
  rain: "/weather/rain.svg",
  sleet: "/weather/sleet.svg",
  snow: "/weather/snow.svg",
  wind: "/weather/wind.svg",
  fog: "/weather/fog.svg",
  thunderstorm: "/weather/thunderstorms-rain.svg",
};

const weatherConditionLabels: Record<WeatherCondition, string> = {
  "clear-day": "Clear (day)",
  "clear-night": "Clear (night)",
  "partly-cloudy-day": "Partly cloudy (day)",
  "partly-cloudy-night": "Partly cloudy (night)",
  cloudy: "Cloudy",
  rain: "Rain",
  sleet: "Sleet",
  snow: "Snow",
  wind: "Wind",
  fog: "Fog",
  thunderstorm: "Thunderstorm",
};

const weatherConditions: WeatherCondition[] = [
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
];

function formatTemp(celsius: number, unit: "C" | "F"): string {
  const value =
    unit === "F" ? Math.round(celsius * 1.8 + 32) : Math.round(celsius);
  return `${value}°${unit}`;
}

export function WeatherWidget({
  widget,
  editing,
  onSave,
}: {
  widget: Widget;
  editing: boolean;
  onSave: (data: object, title: string) => void;
}) {
  const data = widget.data as WeatherWidgetData | null | undefined;
  const [title, setTitle] = useState(widget.title);
  const [location, setLocation] = useState(data?.location ?? "");
  const [date, setDate] = useState(
    data?.date ?? new Date().toISOString().split("T")[0],
  );
  const [condition, setCondition] = useState<WeatherCondition>(
    data?.condition ?? "clear-day",
  );
  const [description, setDescription] = useState(data?.description ?? "");
  const [temperatureC, setTemperatureC] = useState(
    String(data?.temperatureC ?? ""),
  );
  const [highC, setHighC] = useState(String(data?.highC ?? ""));
  const [lowC, setLowC] = useState(String(data?.lowC ?? ""));
  const [unit, setUnit] = useState<"C" | "F">(data?.unit ?? "C");

  useEffect(() => {
    setTitle(widget.title);
  }, [widget.title]);

  useEffect(() => {
    setLocation(data?.location ?? "");
    setDate(data?.date ?? new Date().toISOString().split("T")[0]);
    setCondition(data?.condition ?? "clear-day");
    setDescription(data?.description ?? "");
    setTemperatureC(String(data?.temperatureC ?? ""));
    setHighC(String(data?.highC ?? ""));
    setLowC(String(data?.lowC ?? ""));
    setUnit(data?.unit ?? "C");
  }, [
    data?.location,
    data?.date,
    data?.condition,
    data?.description,
    data?.temperatureC,
    data?.highC,
    data?.lowC,
    data?.unit,
  ]);

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
        <div className="space-y-1">
          <Label className="text-xs">Location</Label>
          <Input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="Melbourne, AU"
            className="h-7 text-sm"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Date</Label>
          <Input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-7 text-sm"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Condition</Label>
          <Select
            value={condition}
            onValueChange={(v) => setCondition(v as WeatherCondition)}
          >
            <SelectTrigger className="h-7 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {weatherConditions.map((c) => (
                <SelectItem key={c} value={c}>
                  {weatherConditionLabels[c]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Description</Label>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Partly cloudy with a light breeze"
            className="h-7 text-sm"
          />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div className="space-y-1">
            <Label className="text-xs">Temp (°C)</Label>
            <Input
              type="number"
              value={temperatureC}
              onChange={(e) => setTemperatureC(e.target.value)}
              className="h-7 text-sm"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">High (°C)</Label>
            <Input
              type="number"
              value={highC}
              onChange={(e) => setHighC(e.target.value)}
              className="h-7 text-sm"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Low (°C)</Label>
            <Input
              type="number"
              value={lowC}
              onChange={(e) => setLowC(e.target.value)}
              className="h-7 text-sm"
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Temperature unit</Label>
          <Select value={unit} onValueChange={(v) => setUnit(v as "C" | "F")}>
            <SelectTrigger className="h-7 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="C">Celsius (°C)</SelectItem>
              <SelectItem value="F">Fahrenheit (°F)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button
          size="sm"
          className="mt-auto"
          onClick={() =>
            onSave(
              {
                location,
                date,
                condition,
                description,
                temperatureC: Number(temperatureC),
                highC: Number(highC),
                lowC: Number(lowC),
                unit,
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
    <div className="flex flex-col items-center justify-center gap-1 p-4 h-full text-center">
      {data ? (
        <>
          <p className="text-sm font-medium leading-tight">{data.location}</p>
          <p className="text-xs text-muted-foreground">
            {new Date(data.date).toLocaleDateString(undefined, {
              weekday: "long",
              month: "long",
              day: "numeric",
            })}
          </p>
          <Image
            src={weatherConditionIcon[data.condition]}
            alt={data.condition}
            width={96}
            height={96}
            className="my-1"
          />
          <p className="text-3xl font-bold leading-none">
            {formatTemp(data.temperatureC, data.unit)}
          </p>
          <p className="text-xs text-muted-foreground mt-1 max-w-[180px]">
            {data.description}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            H: {formatTemp(data.highC, data.unit)} &nbsp; L:{" "}
            {formatTemp(data.lowC, data.unit)}
          </p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground italic">No data yet</p>
      )}
    </div>
  );
}
