import { Hono } from "hono";
import { getTools } from "../tools/index.ts";

const tool = new Hono();

/** List all tools */
tool.get("/", async (c) => {
  const toolsList = Object.entries(getTools()).reduce(
    (acc, [id, tool]) => {
      acc.push({ id, description: tool.description || "No description" });
      return acc;
    },
    [] as { id: string; description: string }[],
  );
  return c.json({ results: toolsList });
});

export { tool };
