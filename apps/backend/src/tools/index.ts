import { type Tool } from "ai";
import {
  convertFahrenheitToCelsius,
  convertCelsiusToFahrenheit,
  calculateCircleArea,
} from "./math.ts";
import { askFollowupQuestion } from "./elicitation.ts";

type ToolSet = {
  id: string;
  name: string;
  category: string;
  description?: string;
  tools: { [toolId: string]: Tool<any, any> };
};

const TOOL_SETS_REGISTRY: {
  [toolSetId: string]: ToolSet;
} = {};

export const registerToolSet = (
  toolSetId: string,
  toolSet: Omit<ToolSet, "id">,
): ToolSet => {
  if (toolSetId in TOOL_SETS_REGISTRY) {
    throw new Error(
      `Tool set with id '${toolSetId}' has already been registered.`,
    );
  }
  TOOL_SETS_REGISTRY[toolSetId] = { id: toolSetId, ...toolSet };
  return TOOL_SETS_REGISTRY[toolSetId];
};

export const getToolSet = (toolSetId: string): ToolSet => {
  if (!(toolSetId in TOOL_SETS_REGISTRY)) {
    throw new Error(`Tool set with id '${toolSetId}' has not been registered.`);
  }
  return TOOL_SETS_REGISTRY[toolSetId];
};

export const getToolSets = (): typeof TOOL_SETS_REGISTRY => TOOL_SETS_REGISTRY;

// REGISTER TOOL SETS HERE!
registerToolSet("math-conversions", {
  name: "Math Conversions",
  category: "Math",
  description: "Temperature and unit conversions",
  tools: {
    convertFahrenheitToCelsius,
    convertCelsiusToFahrenheit,
  },
});

registerToolSet("math-geometry", {
  name: "Math Geometry",
  category: "Math",
  description: "Geometric calculations and formulas",
  tools: {
    calculateCircleArea,
  },
});

registerToolSet("elicitation", {
  name: "Elicitation",
  category: "Elicitation",
  description: "Tools for eliciting information from the user.",
  tools: {
    askFollowupQuestion,
  },
});
