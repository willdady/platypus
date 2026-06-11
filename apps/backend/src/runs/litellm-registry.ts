/**
 * Minimal vendored subset of the litellm model_prices_and_context_window.json
 * (MIT licence — https://github.com/BerriAI/litellm).
 *
 * Only includes `max_input_tokens` and `max_output_tokens` — the two fields
 * {@link ContextWindowResolver} reads. Covers providers whose context window is
 * not available via a live API call (OpenAI, Anthropic, Bedrock). Google and
 * OpenRouter are auto-detected at runtime and do not need entries here.
 *
 * Keys follow the litellm naming convention — bare model ids without a provider
 * prefix. The registry lookup in context-window.ts tries exact → stripped →
 * lowercase → alias → Bedrock ARN → family heuristic before a MISS.
 *
 * Keep sorted alphabetically within each vendor section for easier diffing.
 * Update when models whose windows differ from their family default are released.
 */

import type { Registry } from "./context-window.ts";

const REGISTRY: Registry = {
  // ---------------------------------------------------------------------------
  // OpenAI
  // ---------------------------------------------------------------------------
  "chatgpt-4o-latest": { max_input_tokens: 128000, max_output_tokens: 16384 },
  "gpt-3.5-turbo": { max_input_tokens: 16385, max_output_tokens: 4096 },
  "gpt-3.5-turbo-0125": { max_input_tokens: 16385, max_output_tokens: 4096 },
  "gpt-3.5-turbo-16k": { max_input_tokens: 16385, max_output_tokens: 4096 },
  "gpt-4": { max_input_tokens: 8192, max_output_tokens: 8192 },
  "gpt-4-0125-preview": { max_input_tokens: 128000, max_output_tokens: 4096 },
  "gpt-4-1106-preview": { max_input_tokens: 128000, max_output_tokens: 4096 },
  "gpt-4-turbo": { max_input_tokens: 128000, max_output_tokens: 4096 },
  "gpt-4-turbo-preview": { max_input_tokens: 128000, max_output_tokens: 4096 },
  "gpt-4-vision-preview": { max_input_tokens: 128000, max_output_tokens: 4096 },
  "gpt-4.1": { max_input_tokens: 1047576, max_output_tokens: 32768 },
  "gpt-4.1-mini": { max_input_tokens: 1047576, max_output_tokens: 32768 },
  "gpt-4.1-nano": { max_input_tokens: 1047576, max_output_tokens: 32768 },
  "gpt-4.5-preview": { max_input_tokens: 128000, max_output_tokens: 16384 },
  "gpt-4o": { max_input_tokens: 128000, max_output_tokens: 16384 },
  "gpt-4o-2024-05-13": { max_input_tokens: 128000, max_output_tokens: 4096 },
  "gpt-4o-2024-08-06": { max_input_tokens: 128000, max_output_tokens: 16384 },
  "gpt-4o-2024-11-20": { max_input_tokens: 128000, max_output_tokens: 16384 },
  "gpt-4o-audio-preview": {
    max_input_tokens: 128000,
    max_output_tokens: 16384,
  },
  "gpt-4o-mini": { max_input_tokens: 128000, max_output_tokens: 16384 },
  "gpt-4o-mini-2024-07-18": {
    max_input_tokens: 128000,
    max_output_tokens: 16384,
  },
  "gpt-4o-mini-audio-preview": {
    max_input_tokens: 128000,
    max_output_tokens: 16384,
  },
  o1: { max_input_tokens: 200000, max_output_tokens: 100000 },
  "o1-mini": { max_input_tokens: 128000, max_output_tokens: 65536 },
  "o1-preview": { max_input_tokens: 128000, max_output_tokens: 32768 },
  o3: { max_input_tokens: 200000, max_output_tokens: 100000 },
  "o3-mini": { max_input_tokens: 200000, max_output_tokens: 100000 },
  "o4-mini": { max_input_tokens: 200000, max_output_tokens: 100000 },

  // ---------------------------------------------------------------------------
  // Anthropic (direct API — also covered under bedrock/ below)
  // ---------------------------------------------------------------------------
  "claude-2": { max_input_tokens: 100000, max_output_tokens: 4096 },
  "claude-2.1": { max_input_tokens: 200000, max_output_tokens: 4096 },
  "claude-3-haiku-20240307": {
    max_input_tokens: 200000,
    max_output_tokens: 4096,
  },
  "claude-3-opus-20240229": {
    max_input_tokens: 200000,
    max_output_tokens: 4096,
  },
  "claude-3-sonnet-20240229": {
    max_input_tokens: 200000,
    max_output_tokens: 4096,
  },
  "claude-3-5-haiku-20241022": {
    max_input_tokens: 200000,
    max_output_tokens: 8192,
  },
  "claude-3-5-sonnet-20240620": {
    max_input_tokens: 200000,
    max_output_tokens: 8192,
  },
  "claude-3-5-sonnet-20241022": {
    max_input_tokens: 200000,
    max_output_tokens: 8192,
  },
  "claude-3-7-sonnet-20250219": {
    max_input_tokens: 200000,
    max_output_tokens: 128000,
  },
  "claude-haiku-4-5-20251001": {
    max_input_tokens: 200000,
    max_output_tokens: 8192,
  },
  "claude-opus-4-5": { max_input_tokens: 200000, max_output_tokens: 32000 },
  "claude-opus-4-8": { max_input_tokens: 200000, max_output_tokens: 32000 },
  "claude-sonnet-4-5": { max_input_tokens: 200000, max_output_tokens: 64000 },
  "claude-sonnet-4-6": { max_input_tokens: 200000, max_output_tokens: 64000 },
  "claude-instant-1": { max_input_tokens: 100000, max_output_tokens: 4096 },
  "claude-instant-1.2": { max_input_tokens: 100000, max_output_tokens: 4096 },

  // ---------------------------------------------------------------------------
  // Bedrock — Anthropic models
  // ---------------------------------------------------------------------------
  "bedrock/anthropic.claude-instant-v1": {
    max_input_tokens: 100000,
    max_output_tokens: 4096,
  },
  "bedrock/anthropic.claude-v2": {
    max_input_tokens: 100000,
    max_output_tokens: 4096,
  },
  "bedrock/anthropic.claude-v2:1": {
    max_input_tokens: 200000,
    max_output_tokens: 4096,
  },
  "bedrock/anthropic.claude-3-haiku-20240307-v1:0": {
    max_input_tokens: 200000,
    max_output_tokens: 4096,
  },
  "bedrock/anthropic.claude-3-sonnet-20240229-v1:0": {
    max_input_tokens: 200000,
    max_output_tokens: 4096,
  },
  "bedrock/anthropic.claude-3-opus-20240229-v1:0": {
    max_input_tokens: 200000,
    max_output_tokens: 4096,
  },
  "bedrock/anthropic.claude-3-5-haiku-20241022-v1:0": {
    max_input_tokens: 200000,
    max_output_tokens: 8192,
  },
  "bedrock/anthropic.claude-3-5-sonnet-20240620-v1:0": {
    max_input_tokens: 200000,
    max_output_tokens: 8192,
  },
  "bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0": {
    max_input_tokens: 200000,
    max_output_tokens: 8192,
  },
  "bedrock/anthropic.claude-3-7-sonnet-20250219-v1:0": {
    max_input_tokens: 200000,
    max_output_tokens: 128000,
  },

  // ---------------------------------------------------------------------------
  // Bedrock — Meta Llama
  // ---------------------------------------------------------------------------
  "bedrock/meta.llama3-8b-instruct-v1:0": {
    max_input_tokens: 128000,
    max_output_tokens: 8192,
  },
  "bedrock/meta.llama3-70b-instruct-v1:0": {
    max_input_tokens: 128000,
    max_output_tokens: 8192,
  },
  "bedrock/meta.llama3-1-8b-instruct-v1:0": {
    max_input_tokens: 128000,
    max_output_tokens: 8192,
  },
  "bedrock/meta.llama3-1-70b-instruct-v1:0": {
    max_input_tokens: 128000,
    max_output_tokens: 8192,
  },
  "bedrock/meta.llama3-1-405b-instruct-v1:0": {
    max_input_tokens: 128000,
    max_output_tokens: 8192,
  },
  "bedrock/meta.llama3-2-1b-instruct-v1:0": {
    max_input_tokens: 128000,
    max_output_tokens: 8192,
  },
  "bedrock/meta.llama3-2-3b-instruct-v1:0": {
    max_input_tokens: 128000,
    max_output_tokens: 8192,
  },
  "bedrock/meta.llama3-2-11b-instruct-v1:0": {
    max_input_tokens: 128000,
    max_output_tokens: 8192,
  },
  "bedrock/meta.llama3-2-90b-instruct-v1:0": {
    max_input_tokens: 128000,
    max_output_tokens: 8192,
  },

  // ---------------------------------------------------------------------------
  // Bedrock — Amazon Titan/Nova
  // ---------------------------------------------------------------------------
  "bedrock/amazon.nova-lite-v1:0": {
    max_input_tokens: 300000,
    max_output_tokens: 5120,
  },
  "bedrock/amazon.nova-micro-v1:0": {
    max_input_tokens: 128000,
    max_output_tokens: 5120,
  },
  "bedrock/amazon.nova-pro-v1:0": {
    max_input_tokens: 300000,
    max_output_tokens: 5120,
  },
  "bedrock/amazon.titan-text-express-v1": {
    max_input_tokens: 8192,
    max_output_tokens: 8192,
  },
  "bedrock/amazon.titan-text-lite-v1": {
    max_input_tokens: 4096,
    max_output_tokens: 4096,
  },
  "bedrock/amazon.titan-text-premier-v1:0": {
    max_input_tokens: 32000,
    max_output_tokens: 3072,
  },

  // ---------------------------------------------------------------------------
  // Bedrock — Mistral
  // ---------------------------------------------------------------------------
  "bedrock/mistral.mistral-7b-instruct-v0:2": {
    max_input_tokens: 32768,
    max_output_tokens: 8192,
  },
  "bedrock/mistral.mistral-large-2402-v1:0": {
    max_input_tokens: 32768,
    max_output_tokens: 8192,
  },
  "bedrock/mistral.mistral-large-2407-v1:0": {
    max_input_tokens: 131072,
    max_output_tokens: 8192,
  },
  "bedrock/mistral.mixtral-8x7b-instruct-v0:1": {
    max_input_tokens: 32768,
    max_output_tokens: 8192,
  },

  // ---------------------------------------------------------------------------
  // Mistral (direct API)
  // ---------------------------------------------------------------------------
  "mistral-large": { max_input_tokens: 131072, max_output_tokens: 4096 },
  "mistral-large-latest": { max_input_tokens: 131072, max_output_tokens: 4096 },
  "mistral-medium": { max_input_tokens: 32768, max_output_tokens: 4096 },
  "mistral-small": { max_input_tokens: 32768, max_output_tokens: 4096 },
  "mistral-small-latest": { max_input_tokens: 32768, max_output_tokens: 4096 },
  "mistral-tiny": { max_input_tokens: 32768, max_output_tokens: 4096 },
  "mixtral-8x7b": { max_input_tokens: 32768, max_output_tokens: 4096 },
  "mixtral-8x22b": { max_input_tokens: 65536, max_output_tokens: 4096 },

  // ---------------------------------------------------------------------------
  // Meta Llama (direct / OpenAI-compat, e.g. Together.ai, Fireworks)
  // ---------------------------------------------------------------------------
  "meta-llama/Llama-2-7b-chat-hf": {
    max_input_tokens: 4096,
    max_output_tokens: 4096,
  },
  "meta-llama/Llama-2-13b-chat-hf": {
    max_input_tokens: 4096,
    max_output_tokens: 4096,
  },
  "meta-llama/Llama-2-70b-chat-hf": {
    max_input_tokens: 4096,
    max_output_tokens: 4096,
  },
  "meta-llama/Meta-Llama-3-8B-Instruct": {
    max_input_tokens: 8192,
    max_output_tokens: 8192,
  },
  "meta-llama/Meta-Llama-3-70B-Instruct": {
    max_input_tokens: 8192,
    max_output_tokens: 8192,
  },
  "meta-llama/Meta-Llama-3.1-8B-Instruct": {
    max_input_tokens: 131072,
    max_output_tokens: 8192,
  },
  "meta-llama/Meta-Llama-3.1-70B-Instruct": {
    max_input_tokens: 131072,
    max_output_tokens: 8192,
  },
  "meta-llama/Meta-Llama-3.1-405B-Instruct": {
    max_input_tokens: 131072,
    max_output_tokens: 8192,
  },
  "meta-llama/Llama-3.2-1B-Instruct": {
    max_input_tokens: 131072,
    max_output_tokens: 8192,
  },
  "meta-llama/Llama-3.2-3B-Instruct": {
    max_input_tokens: 131072,
    max_output_tokens: 8192,
  },
  "meta-llama/Llama-3.2-11B-Vision-Instruct": {
    max_input_tokens: 131072,
    max_output_tokens: 8192,
  },
  "meta-llama/Llama-3.2-90B-Vision-Instruct": {
    max_input_tokens: 131072,
    max_output_tokens: 8192,
  },
  "meta-llama/Llama-3.3-70B-Instruct": {
    max_input_tokens: 131072,
    max_output_tokens: 8192,
  },
  "meta-llama/Llama-4-Scout-17B-16E-Instruct": {
    max_input_tokens: 10000000,
    max_output_tokens: 16384,
  },
  "meta-llama/Llama-4-Maverick-17B-128E-Instruct": {
    max_input_tokens: 1000000,
    max_output_tokens: 16384,
  },

  // ---------------------------------------------------------------------------
  // Qwen (via OpenAI-compat, e.g. vLLM / Together)
  // ---------------------------------------------------------------------------
  "Qwen/Qwen2-7B-Instruct": {
    max_input_tokens: 32768,
    max_output_tokens: 8192,
  },
  "Qwen/Qwen2-72B-Instruct": {
    max_input_tokens: 32768,
    max_output_tokens: 8192,
  },
  "Qwen/Qwen2.5-7B-Instruct": {
    max_input_tokens: 131072,
    max_output_tokens: 8192,
  },
  "Qwen/Qwen2.5-14B-Instruct": {
    max_input_tokens: 131072,
    max_output_tokens: 8192,
  },
  "Qwen/Qwen2.5-72B-Instruct": {
    max_input_tokens: 131072,
    max_output_tokens: 8192,
  },
  "Qwen/Qwen3-8B": { max_input_tokens: 131072, max_output_tokens: 8192 },
  "Qwen/Qwen3-14B": { max_input_tokens: 131072, max_output_tokens: 8192 },
  "Qwen/Qwen3-32B": { max_input_tokens: 131072, max_output_tokens: 8192 },
  "Qwen/Qwen3-72B": { max_input_tokens: 131072, max_output_tokens: 8192 },
};

/** Returns the built-in minimal registry. Async so the signature matches the
 *  injected `loadRegistry` slot and allows a future async fetch path. */
export async function loadBuiltinRegistry(): Promise<Registry> {
  return REGISTRY;
}
