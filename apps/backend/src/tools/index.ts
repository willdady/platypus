import { type Tool } from "ai";
import { convertFahrenheitToCelsius } from "./math.ts";

type ToolMetadata = {
  category?: string
};

type RegisteredTool = { tool: Tool<any, any> } & ToolMetadata;

const TOOLS_REGISTRY: {
  [toolId: string]: RegisteredTool;
} = {};

export const registerTool = <T extends Tool>(toolId: string, tool: T, metadata?: ToolMetadata): RegisteredTool => {
  if (toolId in TOOLS_REGISTRY) {
    throw new Error(`Tool with id '${toolId}' has already been registered.`);
  }
  TOOLS_REGISTRY[toolId] = { tool, ...metadata };
  return TOOLS_REGISTRY[toolId];
};

export const getTool = (toolId: string): RegisteredTool => {
  if (!(toolId in TOOLS_REGISTRY)) {
    throw new Error(`Tool with id '${toolId}' has not been registered.`);
  }
  return TOOLS_REGISTRY[toolId];
};

export const getTools = (): typeof TOOLS_REGISTRY => TOOLS_REGISTRY;

// REGISTER TOOLS HERE!
registerTool("convertFahrenheitToCelsius", convertFahrenheitToCelsius, { category: 'Math' });
