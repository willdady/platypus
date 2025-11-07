import { openrouter } from "@openrouter/ai-sdk-provider";
import { Experimental_Agent as Agent, stepCountIs, tool } from "ai";
import { convertFahrenheitToCelsius } from "../tools/math.ts";

const generalAgent = new Agent({
  model: openrouter("deepseek/deepseek-chat-v3-0324"),
  tools: {
    convertFahrenheitToCelsius,
  },
  stopWhen: stepCountIs(20),
});

export { generalAgent };
