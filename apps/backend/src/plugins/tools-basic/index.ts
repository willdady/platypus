import type { PlatypusPlugin } from "@platypuschat/plugin-sdk";
import { PLUGIN_API_VERSION } from "@platypuschat/plugin-sdk";
import {
  convertTemperature,
  convertDistance,
  convertWeight,
  convertVolume,
} from "../../tools/math.ts";
import { createTimeTools } from "../../tools/time.ts";
import { generateUuid, generateNanoId } from "../../tools/identifiers.ts";

export const plugin: PlatypusPlugin = {
  name: "@platypus/tools-basic",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  contributes: {
    toolSets: [
      {
        id: "math-conversions",
        name: "Math Conversions",
        category: "Math",
        description: "Temperature and unit conversions",
        tools: {
          convertTemperature,
          convertDistance,
          convertWeight,
          convertVolume,
        },
      },
      {
        id: "time",
        name: "Time",
        category: "Utilities",
        description:
          "Tools for getting current time and converting between timezones",
        tools: ({ timezone }) => createTimeTools(timezone),
      },
      {
        id: "identifiers",
        name: "Identifiers",
        category: "Utilities",
        description: "Generate unique UUIDs and short nanoids",
        tools: {
          generateUuid,
          generateNanoId,
        },
      },
    ],
  },
};
