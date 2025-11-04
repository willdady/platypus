import { openrouter } from '@openrouter/ai-sdk-provider';
import { Experimental_Agent as Agent, stepCountIs, tool } from 'ai';

const generalAgent = new Agent({
  model: openrouter('deepseek/deepseek-chat-v3-0324'),
  tools: {
    // weather: tool({
    //   description: 'Get the weather in a location (in Fahrenheit)',
    //   inputSchema: z.object({
    //     location: z.string().describe('The location to get the weather for'),
    //   }),
    //   execute: async ({ location }) => ({
    //     location,
    //     temperature: 72 + Math.floor(Math.random() * 21) - 10,
    //   }),
    // }),
    // convertFahrenheitToCelsius: tool({
    //   description: 'Convert temperature from Fahrenheit to Celsius',
    //   inputSchema: z.object({
    //     temperature: z.number().describe('Temperature in Fahrenheit'),
    //   }),
    //   execute: async ({ temperature }) => {
    //     const celsius = Math.round((temperature - 32) * (5 / 9));
    //     return { celsius };
    //   },
    // }),
  },
  stopWhen: stepCountIs(20),
});

export { generalAgent };
