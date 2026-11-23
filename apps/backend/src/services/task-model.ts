import { resolveScoped } from "./scoped-resource.ts";
import { db } from "../index.ts";
import type { ProviderRow } from "./provider-write.ts";

/**
 * Which Provider supplies the **task model** — the one used for background
 * jobs rather than Chat turns.
 *
 * A Workspace may name its own task-model Provider; where it does, that
 * Provider supplies the model for every Chat in the Workspace. Otherwise the
 * Chat's own Provider does. Chat titling and Transcript summarising both read
 * this rule here, so they cannot drift apart.
 */
export type TaskModelWorkspace = {
  taskModelProviderId: string | null;
};

export type TaskModelProviderSelection = {
  providerId: string;
  /** Whether the Workspace's override, rather than the fallback, supplied it. */
  fromOverride: boolean;
};

export type TaskModelProviderResolution = TaskModelProviderSelection & {
  /** The selected Provider, or null when this Workspace cannot see it. */
  provider: ProviderRow | null;
};

/** The Provider id the task model comes from, and why. */
export const taskModelProviderSelection = (
  workspace: TaskModelWorkspace | null | undefined,
  fallbackProviderId: string,
): TaskModelProviderSelection => {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty string falls back too
  const override = workspace?.taskModelProviderId || undefined;
  return override
    ? { providerId: override, fromOverride: true }
    : { providerId: fallbackProviderId, fromOverride: false };
};

/** The Provider reads task-model resolution needs. */
export type TaskModelQueries = {
  getProvider(
    id: string,
    orgId: string,
    workspaceId: string,
  ): Promise<ProviderRow | null>;
};

/** The Provider the task model is read from, resolved as a Scoped resource. */
export const resolveTaskModelProvider = async (
  args: {
    workspace: TaskModelWorkspace | null | undefined;
    fallbackProviderId: string;
    orgId: string;
    workspaceId: string;
  },
  queries: TaskModelQueries,
): Promise<TaskModelProviderResolution> => {
  const selection = taskModelProviderSelection(
    args.workspace,
    args.fallbackProviderId,
  );
  const provider = await queries.getProvider(
    selection.providerId,
    args.orgId,
    args.workspaceId,
  );
  return { provider, ...selection };
};

/**
 * Whether the task model and a Chat's own model are the same model: the same
 * Provider serving the same concrete model id.
 *
 * Never compares model references, so a Chat or Agent naming its model through
 * an alias counts as the same model as long as the alias points there
 * (ADR-0017). Titling and Transcript summarising both ask this question, and
 * read it here so they cannot answer it differently.
 */
export const isChatsOwnModel = (args: {
  taskProviderId: string;
  taskModelId: string;
  chatProviderId: string;
  chatModelId: string;
}): boolean =>
  args.taskProviderId === args.chatProviderId &&
  args.taskModelId === args.chatModelId;

/** The production Provider read: the Scoped-resource authority (ADR-0007), so
 *  a Shared Provider resolves only where an Attachment makes it visible. */
export const drizzleTaskModelQueries: TaskModelQueries = {
  async getProvider(id, orgId, workspaceId) {
    return (
      (await resolveScoped(db, "provider", id, { orgId, workspaceId }))?.row ??
      null
    );
  },
};
