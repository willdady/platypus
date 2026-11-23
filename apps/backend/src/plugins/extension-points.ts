import type {
  SandboxBackendContribution,
  ToolGateContribution,
  ToolSetContribution,
  WebBackendContribution,
} from "@platypuschat/plugin-sdk";
import { SEARCH_SOURCE_NATIVE, SEARCH_SOURCE_NONE } from "@platypus/schemas";
import type { SandboxBackendRegistration } from "../sandbox/index.ts";
import { composeToolSet, type ToolSetRegistration } from "../tools/index.ts";
import {
  composeWebBackend,
  MAX_WEB_TIMEOUT_MS,
  type WebBackendRegistration,
} from "../web-backends/index.ts";
import {
  DEFAULT_TOOL_GATE_TIMEOUT_MS,
  MAX_TOOL_GATE_TIMEOUT_MS,
  type ToolGateRegistration,
} from "../tool-gates/index.ts";
import type { ExtensionPoint } from "./contribution-pipeline.ts";
import { errorMessage } from "../utils/error-message.ts";

const assertTimeoutMs = (
  timeoutMs: unknown,
  max: number,
  what: string,
): void => {
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== "number" ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > max)
  ) {
    throw new Error(
      `${what} declares timeoutMs ${JSON.stringify(
        timeoutMs,
      )}, which must be a positive number no greater than ${max}.`,
    );
  }
};

export const toolSetPoint = (
  register: (id: string, registration: ToolSetRegistration) => void,
): ExtensionPoint<ToolSetRegistration> => ({
  noun: "tool set",
  idField: "id",
  validate: (contribution, { pluginName, rawId }) => {
    if (
      typeof contribution.category !== "string" ||
      contribution.category.trim() === ""
    ) {
      throw new Error(
        `Plugin "${pluginName}": tool set "${rawId}" must declare a non-empty "category".`,
      );
    }
    if (
      typeof contribution.description !== "string" ||
      contribution.description.trim() === ""
    ) {
      throw new Error(
        `Plugin "${pluginName}": tool set "${rawId}" must declare a non-empty "description".`,
      );
    }
    if (
      typeof contribution.tools !== "function" &&
      (typeof contribution.tools !== "object" ||
        contribution.tools === null ||
        Array.isArray(contribution.tools))
    ) {
      throw new Error(
        `Plugin "${pluginName}": tool set "${rawId}" must provide a "tools" object or function.`,
      );
    }
  },
  prepare: (raw, { pluginName, id, plugin, isCore }) => {
    const contribution = raw as unknown as ToolSetContribution;
    return composeToolSet({ contribution, id, plugin, pluginName, isCore });
  },
  register,
});

export const sandboxBackendPoint = (
  register: (registration: SandboxBackendRegistration) => void,
): ExtensionPoint<SandboxBackendRegistration> => ({
  noun: "sandbox backend",
  idField: "backend",
  validate: (contribution, { pluginName, rawId }) => {
    if (typeof contribution.create !== "function") {
      throw new Error(
        `Plugin "${pluginName}": sandbox backend "${rawId}" must provide a "create" function.`,
      );
    }
  },
  prepare: (raw, { pluginName, id, plugin }) => {
    const contribution = raw as unknown as SandboxBackendContribution;

    let configSchema: SandboxBackendRegistration["configSchema"];
    try {
      configSchema =
        typeof contribution.configSchema === "function"
          ? contribution.configSchema(plugin)
          : contribution.configSchema;
    } catch (cause) {
      throw new Error(
        `Plugin "${pluginName}": sandbox backend "${id}" configSchema factory threw (${errorMessage(
          cause,
        )}).`,
        { cause },
      );
    }

    const schemas: [string, unknown][] = [
      ["configSchema", configSchema],
      ["credentialsSchema", contribution.credentialsSchema],
    ];
    for (const [field, schema] of schemas) {
      if (
        typeof schema !== "object" ||
        schema === null ||
        typeof (schema as { safeParse?: unknown }).safeParse !== "function"
      ) {
        throw new Error(
          `Plugin "${pluginName}": sandbox backend "${id}" must provide a Zod "${field}".`,
        );
      }
    }

    return {
      backend: id,
      name: contribution.name,
      configSchema,
      credentialsSchema: contribution.credentialsSchema,
      create: (config, credentials) =>
        contribution.create(config, credentials, plugin),
    };
  },
  register: (_id, registration) => register(registration),
});

export const webBackendPoint = (
  register: (registration: WebBackendRegistration) => void,
): ExtensionPoint<WebBackendRegistration> => ({
  noun: "web backend",
  idField: "backend",
  prepare: (raw, { pluginName, id, plugin }) => {
    const contribution = raw as unknown as WebBackendContribution;

    if (id === SEARCH_SOURCE_NONE || id === SEARCH_SOURCE_NATIVE) {
      throw new Error(
        `Plugin "${pluginName}": web backend "${id}" is reserved by provider.searchSource and can never serve a turn — choose a different id.`,
      );
    }

    if (typeof contribution.createExecutors !== "function") {
      throw new Error(
        `Plugin "${pluginName}": web backend "${id}" must provide a "createExecutors" function.`,
      );
    }

    assertTimeoutMs(
      contribution.timeoutMs,
      MAX_WEB_TIMEOUT_MS,
      `Plugin "${pluginName}": web backend "${id}"`,
    );

    return composeWebBackend({
      contribution,
      backend: id,
      plugin,
      pluginName,
    });
  },
  register: (_id, registration) => register(registration),
});

export const toolGatePoint = (
  register: (registration: ToolGateRegistration) => void,
): ExtensionPoint<ToolGateRegistration> => ({
  noun: "tool gate",
  idField: "id",
  validate: (contribution, { pluginName, rawId }) => {
    if (typeof contribution.evaluate !== "function") {
      throw new Error(
        `Plugin "${pluginName}": tool gate "${rawId}" must provide an "evaluate" function.`,
      );
    }
    if (
      contribution.evaluateResult !== undefined &&
      typeof contribution.evaluateResult !== "function"
    ) {
      throw new Error(
        `Plugin "${pluginName}": tool gate "${rawId}" must provide an "evaluateResult" function when it declares one.`,
      );
    }
    assertTimeoutMs(
      contribution.timeoutMs,
      MAX_TOOL_GATE_TIMEOUT_MS,
      `Plugin "${pluginName}": tool gate "${rawId}"`,
    );
  },
  prepare: (raw, { id, plugin }) => {
    const contribution = raw as unknown as ToolGateContribution;
    const evaluateResult = contribution.evaluateResult?.bind(contribution);
    return {
      id,
      name: contribution.name,
      timeoutMs: contribution.timeoutMs ?? DEFAULT_TOOL_GATE_TIMEOUT_MS,
      evaluate: (call, options) => contribution.evaluate(call, plugin, options),
      evaluateResult: evaluateResult
        ? (call, result, options) =>
            evaluateResult(call, result, plugin, options)
        : undefined,
    };
  },
  register: (_id, registration) => register(registration),
});
