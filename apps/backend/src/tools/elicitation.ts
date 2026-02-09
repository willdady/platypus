import { tool } from "ai";
import { z } from "zod";

export const askFollowupQuestion = tool({
  description: "Ask the user a question with optional follow-up suggestions.",
  inputSchema: z.object({
    question: z.string().describe("The question to ask the user."),
    followUp: z
      .array(z.string())
      .min(2)
      .max(4)
      .optional()
      .describe("A list of 2-4 suggested answers."),
  }),
  // No execute function - this is a client-side tool. Omitting execute
  // ensures the agent loop stops here (can't continue without a result)
  // and prevents sendAutomaticallyWhen from triggering a resubmission.
});
