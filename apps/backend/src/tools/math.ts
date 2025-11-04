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
