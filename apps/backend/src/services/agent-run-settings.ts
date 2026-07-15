import { eq } from "drizzle-orm";
import { db } from "../index.ts";
import { organization } from "../db/schema.ts";
import {
  DEFAULT_PER_RUN_TIMEOUT_MS,
  DEFAULT_PER_STEP_TIMEOUT_MS,
} from "../runs/run-registry.ts";

const MIN_MS = 60 * 1000;

// Chat run defaults mirror the run-registry defaults so a chat run with no env
// override and no org override behaves exactly as before this feature existed.
// Sourced from run-registry to avoid the two constants drifting apart.
const DEFAULT_CHAT_PER_RUN_MS = DEFAULT_PER_RUN_TIMEOUT_MS;
const DEFAULT_CHAT_PER_STEP_MS = DEFAULT_PER_STEP_TIMEOUT_MS;
// Headless trigger runs aren't user-facing, so they get a larger budget than
// chat: crons may do substantial work (multi-step research, long MCP searches).
// These bound runaway runs without tripping on legitimate workloads.
const DEFAULT_TRIGGER_PER_RUN_MS = 60 * MIN_MS;
const DEFAULT_TRIGGER_PER_STEP_MS = 10 * MIN_MS;

const parsePositiveIntMs = (raw: string | undefined, fallback: number) => {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

/**
 * Environment-supplied ceilings. An organization-level override is clamped to
 * these values — an org admin can lower the timeout but never raise it past
 * what the deployer allows.
 *
 * Values are read lazily so test code can override `process.env.*` before
 * invoking the resolver without having to reload the module.
 */
const readCeilings = () => ({
  chatPerRunTimeoutMs: parsePositiveIntMs(
    process.env.RUN_PER_RUN_TIMEOUT_MS,
    DEFAULT_CHAT_PER_RUN_MS,
  ),
  chatPerStepTimeoutMs: parsePositiveIntMs(
    process.env.RUN_PER_STEP_TIMEOUT_MS,
    DEFAULT_CHAT_PER_STEP_MS,
  ),
  triggerPerRunTimeoutMs: parsePositiveIntMs(
    process.env.TRIGGER_PER_RUN_TIMEOUT_MS,
    DEFAULT_TRIGGER_PER_RUN_MS,
  ),
  triggerPerStepTimeoutMs: parsePositiveIntMs(
    process.env.TRIGGER_PER_STEP_TIMEOUT_MS,
    DEFAULT_TRIGGER_PER_STEP_MS,
  ),
});

export type RunKind = "chat" | "trigger";

export type ResolvedTimeouts = {
  perRunTimeoutMs: number;
  perStepTimeoutMs: number;
};

const pickCeilings = (kind: RunKind): ResolvedTimeouts => {
  const c = readCeilings();
  return kind === "chat"
    ? {
        perRunTimeoutMs: c.chatPerRunTimeoutMs,
        perStepTimeoutMs: c.chatPerStepTimeoutMs,
      }
    : {
        perRunTimeoutMs: c.triggerPerRunTimeoutMs,
        perStepTimeoutMs: c.triggerPerStepTimeoutMs,
      };
};

const pickPositive = (v: unknown): number | undefined => {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return undefined;
  return Math.floor(v);
};

const pickOrgOverride = (
  kind: RunKind,
  settings: { [k: string]: unknown } | null | undefined,
): Partial<ResolvedTimeouts> => {
  if (!settings) return {};
  if (kind === "chat") {
    return {
      perRunTimeoutMs: pickPositive(settings.chatPerRunTimeoutMs),
      perStepTimeoutMs: pickPositive(settings.chatPerStepTimeoutMs),
    };
  }
  return {
    perRunTimeoutMs: pickPositive(settings.triggerPerRunTimeoutMs),
    perStepTimeoutMs: pickPositive(settings.triggerPerStepTimeoutMs),
  };
};

/**
 * Resolve effective run timeouts for an organization. The result is always
 * clamped to the environment ceiling — an org override above the ceiling is
 * silently lowered.
 */
export const resolveRunTimeouts = async (
  organizationId: string | null | undefined,
  kind: RunKind,
): Promise<ResolvedTimeouts> => {
  const ceilings = pickCeilings(kind);
  if (!organizationId) return ceilings;

  const rows = await db
    .select({ agentRunSettings: organization.agentRunSettings })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1);
  const settings = rows[0]?.agentRunSettings as
    | Record<string, unknown>
    | null
    | undefined;
  const override = pickOrgOverride(kind, settings);

  return {
    perRunTimeoutMs: Math.min(
      override.perRunTimeoutMs ?? ceilings.perRunTimeoutMs,
      ceilings.perRunTimeoutMs,
    ),
    perStepTimeoutMs: Math.min(
      override.perStepTimeoutMs ?? ceilings.perStepTimeoutMs,
      ceilings.perStepTimeoutMs,
    ),
  };
};

/** Read the current environment ceilings — used by the org-update route to
 * reject incoming overrides above the ceiling rather than silently clamping. */
export const readRunTimeoutCeilings = (kind: RunKind) => pickCeilings(kind);
