import type { PluginConfigContext } from "@platypuschat/plugin-sdk";
import { errorMessage } from "../utils/error-message.ts";
import { isRecord } from "../utils/is-record.ts";

export type RawContribution = Record<string, unknown>;

export interface ContributionIdentity {
  pluginName: string;
  rawId: string;
}

interface ContributionContext {
  pluginName: string;
  id: string;
  plugin: PluginConfigContext;
  isCore: boolean;
}

export interface ExtensionPoint<TRegistration = unknown> {
  noun: string;
  idField: string;
  validate?(
    contribution: RawContribution,
    identity: ContributionIdentity,
  ): void;
  prepare(
    contribution: RawContribution,
    context: ContributionContext,
  ): TRegistration;
  register(id: string, registration: TRegistration): void;
}

export interface RegisterContributionsOptions<TRegistration> {
  point: ExtensionPoint<TRegistration>;
  contributions: readonly unknown[];
  pluginName: string;
  plugin: PluginConfigContext;
  contributionId: (id: string) => string;
  isCore: boolean;
  owners: Map<string, string>;
}

const sentenceCase = (noun: string): string =>
  noun.charAt(0).toUpperCase() + noun.slice(1);

export const registerContributions = <TRegistration>(
  options: RegisterContributionsOptions<TRegistration>,
): string[] => {
  const {
    point,
    contributions,
    pluginName,
    plugin,
    contributionId,
    isCore,
    owners,
  } = options;
  const registeredIds: string[] = [];

  for (const [index, contribution] of contributions.entries()) {
    if (!isRecord(contribution)) {
      throw new Error(
        `Plugin "${pluginName}": every ${point.noun} contribution must be an object (at index ${index}).`,
      );
    }

    const raw = contribution as RawContribution;
    const rawId = raw[point.idField];
    if (typeof rawId !== "string" || rawId.trim() === "") {
      throw new Error(
        `Plugin "${pluginName}": every ${point.noun} must declare a non-empty "${point.idField}" (at index ${index}).`,
      );
    }
    if (typeof raw.name !== "string" || raw.name.trim() === "") {
      throw new Error(
        `Plugin "${pluginName}": ${point.noun} "${rawId}" must declare a non-empty "name".`,
      );
    }

    point.validate?.(raw, { pluginName, rawId });

    const id = contributionId(rawId.trim());

    const existingOwner = owners.get(id);
    if (existingOwner) {
      throw new Error(
        `${sentenceCase(point.noun)} id "${id}" is contributed by both "${existingOwner}" and "${pluginName}".`,
      );
    }

    const registration = point.prepare(raw, {
      pluginName,
      id,
      plugin,
      isCore,
    });

    try {
      point.register(id, registration);
    } catch (cause) {
      throw new Error(
        `Plugin "${pluginName}": failed to register ${point.noun} "${id}" (${errorMessage(
          cause,
        )}).`,
        { cause },
      );
    }

    owners.set(id, pluginName);
    registeredIds.push(id);
  }

  return registeredIds;
};
