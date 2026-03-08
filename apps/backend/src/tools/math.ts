import { tool } from "ai";
import { z } from "zod";

export const convertTemperature = tool({
  description:
    "Convert temperature between Fahrenheit, Celsius, and Kelvin. Specify the value and the units to convert from and to.",
  inputSchema: z.object({
    value: z.number().describe("The temperature value to convert"),
    from: z
      .enum(["fahrenheit", "celsius", "kelvin"])
      .describe("The unit to convert from"),
    to: z
      .enum(["fahrenheit", "celsius", "kelvin"])
      .describe("The unit to convert to"),
  }),
  execute: async ({ value, from, to }) => {
    let celsius: number;
    if (from === "celsius") celsius = value;
    else if (from === "fahrenheit") celsius = (value - 32) * (5 / 9);
    else celsius = value - 273.15;

    let result: number;
    if (to === "celsius") result = celsius;
    else if (to === "fahrenheit") result = (celsius * 9) / 5 + 32;
    else result = celsius + 273.15;

    return { result: Math.round(result * 100) / 100, unit: to };
  },
});

const DISTANCE_TO_METERS: Record<string, number> = {
  meters: 1,
  centimeters: 0.01,
  kilometers: 1000,
  miles: 1609.344,
  feet: 0.3048,
  inches: 0.0254,
};

export const convertDistance = tool({
  description:
    "Convert distance between metric and imperial units. Supports meters, centimeters, kilometers, miles, feet, and inches.",
  inputSchema: z.object({
    value: z.number().describe("The distance value to convert"),
    from: z
      .enum(["meters", "centimeters", "kilometers", "miles", "feet", "inches"])
      .describe("The unit to convert from"),
    to: z
      .enum(["meters", "centimeters", "kilometers", "miles", "feet", "inches"])
      .describe("The unit to convert to"),
  }),
  execute: async ({ value, from, to }) => {
    if (from === to) return { result: value, unit: to };
    const meters = value * DISTANCE_TO_METERS[from];
    const result = meters / DISTANCE_TO_METERS[to];
    return { result: Math.round(result * 100) / 100, unit: to };
  },
});

export const convertWeight = tool({
  description:
    "Convert weight between kilograms and pounds. Specify the value and the units to convert from and to.",
  inputSchema: z.object({
    value: z.number().describe("The weight value to convert"),
    from: z
      .enum(["kilograms", "pounds"])
      .describe("The unit to convert from"),
    to: z
      .enum(["kilograms", "pounds"])
      .describe("The unit to convert to"),
  }),
  execute: async ({ value, from, to }) => {
    if (from === to) return { result: value, unit: to };
    const result =
      from === "kilograms" ? value * 2.20462 : value / 2.20462;
    return { result: Math.round(result * 100) / 100, unit: to };
  },
});

export const convertVolume = tool({
  description:
    "Convert volume between liters and gallons. Specify the value and the units to convert from and to.",
  inputSchema: z.object({
    value: z.number().describe("The volume value to convert"),
    from: z
      .enum(["liters", "gallons"])
      .describe("The unit to convert from"),
    to: z
      .enum(["liters", "gallons"])
      .describe("The unit to convert to"),
  }),
  execute: async ({ value, from, to }) => {
    if (from === to) return { result: value, unit: to };
    const result =
      from === "liters" ? value * 0.264172 : value / 0.264172;
    return { result: Math.round(result * 100) / 100, unit: to };
  },
});
