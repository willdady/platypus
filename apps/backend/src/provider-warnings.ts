import type { Warning } from "ai";
import { logger } from "./logger.ts";

/**
 * What the Provider said it did not honour, written to the log.
 *
 * The AI SDK reports, per call, that a setting it was handed was dropped,
 * clamped or stripped for this model — Bedrock discards `seed`,
 * `presencePenalty` and `frequencyPenalty` outright and clamps `temperature`
 * into 0–1; Anthropic strips `temperature`, `topP` and `topK` on the models
 * that reject sampling parameters. Every one of those is an Agent field an
 * Operator filled in and got no feedback on (issue #411).
 *
 * The SDK's hook is a process global rather than a per-call option, which is
 * the reason to use it: one assignment covers the streaming Chat turn, the
 * unattended run, sub-agent runs, title generation and memory extraction, and
 * a generation call site added later needs no wiring to be covered. The price
 * is attribution — the hook carries a provider and a model id and nothing
 * else, so a line cannot name the Chat or Agent that caused it. That is a
 * deliberate trade rather than an oversight; correlating a warning to a run
 * would mean threading async context through every path, which is the cost the
 * global exists to avoid.
 */

/** The structured fields a warning contributes to its log entry. */
type WarningFields = {
  warningType: Warning["type"];
  feature?: string;
  setting?: string;
  details?: string;
  message?: string;
};

/**
 * Split a warning into its own fields, keeping the variant's shape.
 *
 * Logged as fields rather than a stringified object so an Operator can filter
 * on `feature` — "did anything drop my temperature?" is the question this is
 * here to answer.
 */
const warningFields = (warning: Warning): WarningFields => {
  switch (warning.type) {
    case "unsupported":
    case "compatibility":
      return {
        warningType: warning.type,
        feature: warning.feature,
        ...(warning.details !== undefined ? { details: warning.details } : {}),
      };
    case "deprecated":
      return {
        warningType: warning.type,
        setting: warning.setting,
        message: warning.message,
      };
    default:
      return { warningType: warning.type, message: warning.message };
  }
};

/**
 * The sentence an Operator reads, which has to stand on its own: under
 * `pino/file` in production the fields are there too, but the message is what
 * gets grepped and what gets pasted into a bug report.
 */
const describeWarning = (warning: Warning): string => {
  switch (warning.type) {
    case "unsupported":
      return warning.details
        ? `does not support ${warning.feature}: ${warning.details}`
        : `does not support ${warning.feature}, so the value set for it was ignored`;
    case "compatibility":
      return warning.details
        ? `applied a compatibility fallback for ${warning.feature}: ${warning.details}`
        : `applied a compatibility fallback for ${warning.feature}`;
    case "deprecated":
      return `reports ${warning.setting} as deprecated: ${warning.message}`;
    default:
      return `reported: ${warning.message}`;
  }
};

/** Name the call the warning came from, skipping whatever the SDK left out. */
const describeCall = (provider?: string, model?: string): string => {
  if (provider && model) return `${provider} (${model})`;
  return provider ?? model ?? "the Provider";
};

/**
 * Point the SDK's warning logger at pino.
 *
 * Assigning the global displaces the SDK's default, which writes to
 * `process.emitWarning`, so nothing is logged twice. Called once during
 * startup; a call with no warnings never reaches this and writes nothing.
 */
export const installProviderWarningLogger = (): void => {
  globalThis.AI_SDK_LOG_WARNINGS = ({ warnings, provider, model }) => {
    for (const warning of warnings) {
      logger.warn(
        {
          ...(provider !== undefined ? { provider } : {}),
          ...(model !== undefined ? { model } : {}),
          ...warningFields(warning),
        },
        `${describeCall(provider, model)} ${describeWarning(warning)}`,
      );
    }
  };
};
