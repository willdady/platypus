import { describe, it, expect } from "vitest";
import { callTool } from "../test-utils.ts";
import {
  convertTemperature,
  convertDistance,
  convertWeight,
  convertVolume,
} from "./math.ts";

describe("convertTemperature", () => {
  it("converts 0°C to 32°F", async () => {
    const result = await callTool(convertTemperature, {
      value: 0,
      from: "celsius",
      to: "fahrenheit",
    });
    expect(result.result).toBe(32);
    expect(result.unit).toBe("fahrenheit");
  });

  it("converts 212°F to 100°C", async () => {
    const result = await callTool(convertTemperature, {
      value: 212,
      from: "fahrenheit",
      to: "celsius",
    });
    expect(result.result).toBe(100);
    expect(result.unit).toBe("celsius");
  });

  it("converts 0°C to 273.15K", async () => {
    const result = await callTool(convertTemperature, {
      value: 0,
      from: "celsius",
      to: "kelvin",
    });
    expect(result.result).toBe(273.15);
    expect(result.unit).toBe("kelvin");
  });

  it("converts 0K to -273.15°C", async () => {
    const result = await callTool(convertTemperature, {
      value: 0,
      from: "kelvin",
      to: "celsius",
    });
    expect(result.result).toBe(-273.15);
    expect(result.unit).toBe("celsius");
  });

  it("returns unchanged value when converting same unit", async () => {
    const result = await callTool(convertTemperature, {
      value: 42,
      from: "celsius",
      to: "celsius",
    });
    expect(result.result).toBe(42);
    expect(result.unit).toBe("celsius");
  });

  it("rounds to 2 decimal places", async () => {
    const result = await callTool(convertTemperature, {
      value: 1,
      from: "celsius",
      to: "fahrenheit",
    });
    expect(result.result).toBe(33.8);
  });
});

describe("convertDistance", () => {
  it("converts 1 mile to 1.61 km", async () => {
    const result = await callTool(convertDistance, {
      value: 1,
      from: "miles",
      to: "kilometers",
    });
    expect(result.result).toBe(1.61);
    expect(result.unit).toBe("kilometers");
  });

  it("converts 1 inch to 2.54 cm", async () => {
    const result = await callTool(convertDistance, {
      value: 1,
      from: "inches",
      to: "centimeters",
    });
    expect(result.result).toBe(2.54);
    expect(result.unit).toBe("centimeters");
  });

  it("returns unchanged value when converting same unit", async () => {
    const result = await callTool(convertDistance, {
      value: 5,
      from: "meters",
      to: "meters",
    });
    expect(result.result).toBe(5);
    expect(result.unit).toBe("meters");
  });
});

describe("convertWeight", () => {
  it("converts 1 kg to 2.2 lbs", async () => {
    const result = await callTool(convertWeight, {
      value: 1,
      from: "kilograms",
      to: "pounds",
    });
    expect(result.result).toBe(2.2);
    expect(result.unit).toBe("pounds");
  });

  it("converts 1 lb to 0.45 kg", async () => {
    const result = await callTool(convertWeight, {
      value: 1,
      from: "pounds",
      to: "kilograms",
    });
    expect(result.result).toBe(0.45);
    expect(result.unit).toBe("kilograms");
  });
});

describe("convertVolume", () => {
  it("converts 1 liter to 0.26 gallons", async () => {
    const result = await callTool(convertVolume, {
      value: 1,
      from: "liters",
      to: "gallons",
    });
    expect(result.result).toBe(0.26);
    expect(result.unit).toBe("gallons");
  });

  it("converts 1 gallon to 3.79 liters", async () => {
    const result = await callTool(convertVolume, {
      value: 1,
      from: "gallons",
      to: "liters",
    });
    expect(result.result).toBe(3.79);
    expect(result.unit).toBe("liters");
  });
});
