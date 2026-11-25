import { redirect } from "next/navigation";
import { workspaceRoutes } from "@/lib/routes";

async function TriggerRunsRedirect({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; triggerId: string }>;
}) {
  const { orgId, workspaceId, triggerId } = await params;

  redirect(
    workspaceRoutes(orgId, workspaceId).triggerRuns.forTrigger(triggerId),
  );
}

export default TriggerRunsRedirect;
