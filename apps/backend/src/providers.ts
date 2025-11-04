/// <reference types="node" />
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

const { OPENROUTER_API_KEY } = process.env;

const openrouter = createOpenRouter({
  apiKey: OPENROUTER_API_KEY,
});

export { openrouter };
