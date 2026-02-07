import { tool } from "ai";
import { z } from "zod";

/**
 * Creates the newTask tool for delegating to sub-agents.
 * This is a client-side tool - it has no execute function.
 * The frontend handles the tool call by opening the side pane.
 */
export const createNewTaskTool = (
  subAgents: Array<{ id: string; name: string; description?: string }>
) => {
  const subAgentDescriptions = subAgents
    .map((sa) => `- ${sa.name} (${sa.id}): ${sa.description || "No description"}`)
    .join("\n");

  return tool({
    description: `Delegate a task to a specialized sub-agent. Available sub-agents:\n${subAgentDescriptions}`,
    inputSchema: z.object({
      subAgentId: z.string().describe("The ID of the sub-agent to delegate to"),
      task: z.string().describe("A fully self-contained task description. The sub-agent has NO access to the parent conversation or other tasks, so include ALL necessary context, constraints, and requirements directly. Never reference other tasks or prior context."),
    }),
    // No execute function - this is a client-side tool
  });
};

/**
 * Creates the taskResult tool for sub-agents to return their results.
 * This tool signals completion of the sub-agent task.
 * It is a client-side tool that the frontend uses to capture the result
 * and return it to the parent agent.
 */
export const createTaskResultTool = () => {
  return tool({
    description: "Call this tool when you have completed your assigned task. This will return control to the parent agent.",
    inputSchema: z.object({
      result: z.string().describe("The complete result of your task"),
      status: z.enum(["success", "error"]).describe("Whether the task was completed successfully"),
    }),
    // No execute function - this is a client-side tool
  });
};
