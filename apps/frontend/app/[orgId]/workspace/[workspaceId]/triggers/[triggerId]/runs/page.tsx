import { redirect } from "next/navigation";
import { workspaceRoutes } from "@/lib/routes";

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
    workspaceRoutes(orgId, workspaceId).triggerRuns.forTrigger(triggerId),
  );
};

export default TriggerRunsRedirect;
