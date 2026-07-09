import type { PlatypusPlugin } from "@platypuschat/plugin-sdk";
import { PLUGIN_API_VERSION } from "@platypuschat/plugin-sdk";
import {
  convertTemperature,
  convertDistance,
  convertWeight,
  convertVolume,
} from "../../tools/math.ts";
import { getCurrentTime, convertTimezone } from "../../tools/time.ts";

// First core plugin: pure utility Tool sets (math, time). Grouped by cohesion
// per ADR-0013 (a capability gets its own plugin when an Operator would
// plausibly want to deny it in isolation — utilities don't). Core ids stay
// unprefixed, so every persisted `agent.toolSetIds` reference keeps working.
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
        tools: {
          getCurrentTime,
          convertTimezone,
        },
      },
    ],
  },
};
