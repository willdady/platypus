import { tool } from "ai";
import { z } from "zod";

export const convertFahrenheitToCelsius = tool({
  description: "Convert temperature from Fahrenheit to Celsius",
  inputSchema: z.object({
    temperature: z.number().describe("Temperature in Fahrenheit"),
  }),
  execute: async ({ temperature }) => {
    const celsius = Math.round((temperature - 32) * (5 / 9));
    return { celsius };
  },
});

export const convertCelsiusToFahrenheit = tool({
  description: "Convert temperature from Celsius to Fahrenheit",
  inputSchema: z.object({
    temperature: z.number().describe("Temperature in Celsius"),
  }),
  execute: async ({ temperature }) => {
    const fahrenheit = Math.round((temperature * 9) / 5 + 32);
    return { fahrenheit };
  },
});

export const calculateCircleArea = tool({
  description: "Calculate the area of a circle given its radius",
  inputSchema: z.object({
    radius: z.number().describe("Radius of the circle"),
  }),
  execute: async ({ radius }) => {
    const area = Math.PI * radius * radius;
    return { area };
  },
});
