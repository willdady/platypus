import type {
  PlatypusPlugin,
  ToolGateCall,
  ToolGateContribution,
  ToolGateVerdict,
} from "@platypuschat/plugin-sdk";
import { PLUGIN_API_VERSION } from "@platypuschat/plugin-sdk";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import {
  createGateway,
  experimental_decide as decide,
  type Experimental_DecisionModel,
} from "ai";
import { z } from "zod";

// Core plugin: the reference Tool gate (ADR-0033). Asks a decision model one
// yes/no question about each tool call and maps the probability to a Verdict
// with two Operator-set thresholds. Off by default; the model, its credentials
// and the thresholds stay together in this plugin's config, because confidence
// from one model means nothing for another (#1257).

const DEFAULT_GATEWAY_MODEL = "typesafe-ai/jev";

const configSchema = z
  .object({
    // The `@ai-sdk/*` providers that serve a decision model.
    provider: z
      .enum(["gateway", "anthropic", "openai", "google"])
      .default("gateway"),
    model: z.string().min(1).optional(),
    denyThreshold: z.number().min(0).max(1),
    askThreshold: z.number().min(0).max(1).optional(),
  })
  .strict()
  .refine((c) => c.provider === "gateway" || c.model !== undefined, {
    message: "model is required for every provider but gateway",
    path: ["model"],
  })
  .refine(
    (c) => c.askThreshold === undefined || c.askThreshold <= c.denyThreshold,
    {
      message: "askThreshold must not be above denyThreshold",
      path: ["askThreshold"],
    },
  );

const credentialsSchema = z.object({ apiKey: z.string().min(1) }).strict();

export type DecisionGateConfig = z.infer<typeof configSchema>;
type DecisionGateCredentials = z.infer<typeof credentialsSchema>;

const openDecisionModel = (
  config: DecisionGateConfig,
  { apiKey }: DecisionGateCredentials,
): Experimental_DecisionModel => {
  switch (config.provider) {
    case "gateway":
      return createGateway({ apiKey }).decisionModel(
        config.model ?? DEFAULT_GATEWAY_MODEL,
      );
    case "anthropic":
      return createAnthropic({ apiKey }).decisionModel(config.model!);
    case "openai":
      return createOpenAI({ apiKey }).decisionModel(config.model!);
    case "google":
      return createGoogleGenerativeAI({ apiKey }).decisionModel(config.model!);
  }
};

/** Ask `model` whether `call` is destructive, and map its answer to a Verdict. */
export const judgeToolCall = async (
  model: Experimental_DecisionModel,
  call: ToolGateCall,
  { denyThreshold, askThreshold }: DecisionGateConfig,
  signal: AbortSignal,
): Promise<ToolGateVerdict> => {
  const { answers } = await decide({
    model,
    // JSON round-trip: the model's arguments are whatever it sent, and the
    // state must be plain JSON.
    state: JSON.parse(
      JSON.stringify({
        toolName: call.toolName,
        toolDescription: call.toolDescription ?? null,
        args: call.args ?? null,
        readOnlyHint: call.readOnlyHint,
      }),
    ) as Parameters<typeof decide>[0]["state"],
    questions: {
      destructive: {
        type: "boolean",
        instructions:
          "Is this tool call destructive or irreversible? It is when running it could delete, overwrite or corrupt data, change something outside the sandbox that cannot be undone, or spend money.",
      },
    },
    abortSignal: signal,
  });
  const p = answers.destructive.probability;
  const reason = `Judged destructive or irreversible with probability ${p.toFixed(2)}.`;
  if (p >= denyThreshold) return { verdict: "deny", reason };
  if (askThreshold !== undefined && p >= askThreshold) {
    return { verdict: "ask", reason };
  }
  return { verdict: "allow" };
};

const decisionModelGate: ToolGateContribution = {
  id: "decision-model",
  name: "Decision model",
  evaluate: (call, plugin, { signal }) =>
    judgeToolCall(
      openDecisionModel(
        plugin.config as DecisionGateConfig,
        plugin.credentials as DecisionGateCredentials,
      ),
      call,
      plugin.config as DecisionGateConfig,
      signal,
    ),
};

export const plugin: PlatypusPlugin = {
  name: "@platypus/decision-gate",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  configSchema,
  credentialsSchema,
  contributes: {
    toolGates: [decisionModelGate],
  },
};
