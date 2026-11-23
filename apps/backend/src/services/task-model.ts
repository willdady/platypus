import { resolveScoped } from "./scoped-resource.ts";
import { db } from "../index.ts";
import type { ProviderRow } from "./provider-write.ts";

export type TaskModelWorkspace = {
  taskModelProviderId: string | null;
};

export type TaskModelProviderSelection = {
  providerId: string;
  fromOverride: boolean;
};

export type TaskModelProviderResolution = TaskModelProviderSelection & {
  provider: ProviderRow | null;
};

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

export type TaskModelQueries = {
  getProvider(
    id: string,
    orgId: string,
    workspaceId: string,
  ): Promise<ProviderRow | null>;
};

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

export const isChatsOwnModel = (args: {
  taskProviderId: string;
  taskModelId: string;
  chatProviderId: string;
  chatModelId: string;
}): boolean =>
  args.taskProviderId === args.chatProviderId &&
  args.taskModelId === args.chatModelId;

export const drizzleTaskModelQueries: TaskModelQueries = {
  async getProvider(id, orgId, workspaceId) {
    return (
      (await resolveScoped(db, "provider", id, { orgId, workspaceId }))?.row ??
      null
    );
  },
};
