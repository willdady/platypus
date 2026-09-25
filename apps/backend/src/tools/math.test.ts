import { describe, it, expect } from "vitest";
import type { Tool } from "ai";
import { callTool } from "../test-utils.ts";
import {
  convertTemperature,
  convertDistance,
  convertWeight,
  convertVolume,
} from "./math.ts";

// [tool, value, from, to, expected]. Results round to 2 decimal places; a
// same-unit conversion returns the value untouched (no rounding).
const cases: [string, Tool, number, string, string, number][] = [
  ["temperature", convertTemperature, 0, "celsius", "fahrenheit", 32],
  ["temperature", convertTemperature, 1, "celsius", "fahrenheit", 33.8],
  ["temperature", convertTemperature, 212, "fahrenheit", "celsius", 100],
  ["temperature", convertTemperature, 32, "fahrenheit", "kelvin", 273.15],
  ["temperature", convertTemperature, 0, "celsius", "kelvin", 273.15],
  ["temperature", convertTemperature, 0, "kelvin", "celsius", -273.15],
  ["temperature", convertTemperature, 0, "kelvin", "fahrenheit", -459.67],
  ["temperature", convertTemperature, 42, "celsius", "celsius", 42],
  ["distance", convertDistance, 1, "miles", "kilometers", 1.61],
  ["distance", convertDistance, 1, "inches", "centimeters", 2.54],
  ["distance", convertDistance, 1.23456, "meters", "meters", 1.23456],
  ["weight", convertWeight, 1, "kilograms", "pounds", 2.2],
  ["weight", convertWeight, 1, "pounds", "kilograms", 0.45],
  ["weight", convertWeight, 1.23456, "pounds", "pounds", 1.23456],
  ["volume", convertVolume, 1, "liters", "gallons", 0.26],
  ["volume", convertVolume, 1, "gallons", "liters", 3.79],
  ["volume", convertVolume, 1.23456, "liters", "liters", 1.23456],
];

describe("unit conversion tools", () => {
  it.each(cases)(
    "%s: %d %s → %s = %d",
    async (_kind, tool, value, from, to, expected) => {
      expect(await callTool(tool, { value, from, to })).toEqual({
        result: expected,
        unit: to,
      });
    },
  );
});
