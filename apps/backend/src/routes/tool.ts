import { Hono } from "hono";
import { getTools } from "../tools/index.ts";
import { type Tool } from "@agent-kit/schemas";

const tool = new Hono();

/** List all tools */
tool.get("/", async (c) => {
  const toolsList = Object.entries(getTools()).reduce(
    (acc, [id, registeredTool]) => {
      acc.push({
        id,
        description: registeredTool.tool.description || "No description",
        category: registeredTool.category,
      });
      return acc;
    },
    [] as Tool[],
  );
  return c.json({ results: toolsList });
});

export { tool };
