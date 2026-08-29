import { redirect } from "next/navigation";

/**
 * Runs used to be read one Trigger at a time, at this address. They are now a
 * single workspace-wide list; this route stays only so existing links and
 * bookmarks land there with the Trigger already selected in the filter.
 */
const TriggerRunsRedirect = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; triggerId: string }>;
}) => {
  const { orgId, workspaceId, triggerId } = await params;

  redirect(
    `/${orgId}/workspace/${workspaceId}/trigger-runs?triggerId=${encodeURIComponent(
      triggerId,
    )}`,
  );
};

export default TriggerRunsRedirect;
