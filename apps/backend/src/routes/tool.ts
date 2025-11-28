import { Hono } from "hono";
import { getToolSets } from "../tools/index.ts";

const tool = new Hono();

/** List all tool sets */
tool.get("/", async (c) => {
  const toolSetsList = Object.entries(getToolSets()).map(([id, toolSet]) => ({
    id,
    category: toolSet.category,
    description: toolSet.description,
    tools: Object.entries(toolSet.tools).map(([toolId, tool]) => ({
      id: toolId,
      description: tool.description || "No description",
    })),
  }));
  return c.json({ results: toolSetsList });
});

export { tool };
