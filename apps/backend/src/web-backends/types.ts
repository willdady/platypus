import type { Tool } from "ai";
import { z } from "zod";
import type { WebBackendContext } from "@platypuschat/plugin-sdk";

// The SDK is the single home of the executor-facing contract; core re-exports the
// types its internal callers need so nothing below imports the SDK directly.
export type {
  ReadUrlResult,
  WebBackendContext,
  WebBackendContribution,
  WebBackendExecutors,
  WebSearchResult,
  WebSearchResults,
} from "@platypuschat/plugin-sdk";

// Core-owned, fixed input schemas (ADR-0014). A backend supplies executors only,
// so every Web-search backend presents the *same* model-facing signature and an
// Agent prompt does not couple to whichever backend an Operator configured.
//
// Tool names are snake_case — a deliberate, documented exception to the repo's
// camelCase tools (`fetchUrl`, `fsRead`…). These fill the slot provider-native
// search occupies, where the vocabulary is already `web_search`, and models carry
// strong priors on that name from the hosted OpenAI/Anthropic tools.

export const webSearchInputSchema = z.object({
  query: z.string().min(1).describe("The search query"),
});
export type WebSearchInput = z.infer<typeof webSearchInputSchema>;

// Mirrors `fetchUrl`'s pagination inputs byte-for-byte (max_length default 5000,
// start_index default 0) so a continuation read reads identically on both tools.
export const readUrlInputSchema = z.object({
  url: z.string().url().describe("URL to read"),
  max_length: z
    .number()
    .int()
    .min(1)
    // Mirrors `MAX_READ_URL_CONTENT_CHARS` in `index.ts`, which can't be
    // imported here without a circular dependency (`index.ts` imports this
    // module). Keep the two numbers in sync by hand.
    .max(1_000_000)
    .default(5_000)
    .describe("Maximum number of characters to return"),
  start_index: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Start character index for pagination"),
});
export type ReadUrlInput = z.infer<typeof readUrlInputSchema>;

// Model-facing returns. snake_case here, camelCase in the SDK types: this side
// must match `fetchUrl` exactly (see readUrlInputSchema above).

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

/**
 * What a Tool returns to the model when the call could not be served — a blocked
 * URL, a timeout, or a backend throw. A returned error object, not a rejection:
 * an executor throw must not surface as an AI-SDK tool error and abort the turn
 * (ADR-0014).
 */
export type WebToolError = { error: string };

/**
 * One registered Web-search backend. The discriminator string lives in the
 * `provider.webBackend` column.
 *
 * `buildTurnTools` is the finished, guarded builder produced by
 * {@link composeWebBackend}: it resolves the backend's executors for this turn
 * and returns core-built `Tool`s with the caps, slicing, timeout, egress guard,
 * and error contract already applied. Per-turn callers just `Object.assign` its
 * output onto the turn's tool map.
 *
 * It is `buildTurnTools`, not `createTools`, on purpose: `createTools` is the
 * exact identifier ADR-0014 **rejects** for the contribution factory, so reusing
 * it on core's side of the seam would read as the rejected shape.
 */
export interface WebBackendRegistration {
  backend: string;
  name: string;
  buildTurnTools(ctx: WebBackendContext): Promise<Record<string, Tool>>;
}
