import type { Warning } from "ai";
import { logger } from "./logger.ts";

type WarningFields = {
  warningType: Warning["type"];
  feature?: string;
  setting?: string;
  details?: string;
  message?: string;
};

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

const describeCall = (provider?: string, model?: string): string => {
  if (provider && model) return `${provider} (${model})`;
  return provider ?? model ?? "the Provider";
};

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
