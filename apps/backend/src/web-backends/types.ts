import type { Tool } from "ai";
import { z } from "zod";
import type { WebBackendContext } from "@platypuschat/plugin-sdk";
import type { WithCoreRegistrar } from "../tools/closers.ts";

export type {
  WebBackendContext,
  WebBackendContribution,
  WebBackendExecutors,
} from "@platypuschat/plugin-sdk";

export const MAX_URL_CHARS = 2_048;
export const MAX_READ_URL_CONTENT_CHARS = 1_000_000;
export const MAX_READ_URL_SLICE_CHARS = 100_000;

export const webSearchInputSchema = z.object({
  query: z.string().min(1).describe("The search query"),
});

export const readUrlInputSchema = z.object({
  url: z.url().describe("URL to read"),
  max_length: z
    .number()
    .int()
    .min(1)
    .max(MAX_READ_URL_CONTENT_CHARS)
    .default(5_000)
    .describe("Maximum number of characters to return"),
  start_index: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Start character index for pagination"),
});

export type WebSearchToolResult = {
  query: string;
  results: Array<{ title: string; url: string; snippet?: string }>;
  answer?: string;
};

export type ReadUrlToolResult = {
  content: string;
  url: string;
  content_type: string;
  truncated: boolean;
  next_start_index?: number;
};

export type WebToolError = { error: string };

export type TurnToolsContext = WithCoreRegistrar<WebBackendContext> & {
  providerId: string;
};

export interface WebBackendRegistration {
  backend: string;
  name: string;
  buildTurnTools(ctx: TurnToolsContext): Promise<Record<string, Tool>>;
}
