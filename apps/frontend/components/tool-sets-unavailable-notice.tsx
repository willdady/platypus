import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { ToolSetsFailureReason } from "@/lib/tool-sets-request";

// why: never substitute an empty list for a failed read — it hides the misconfiguration
export function ToolSetsUnavailableNotice({
  reason,
  scope,
  hasExistingSelections,
}: {
  reason: ToolSetsFailureReason;
  scope: "organization" | "workspace";
  hasExistingSelections: boolean;
}) {
  const owner = scope === "organization" ? "Organization" : "Workspace";

  return (
    <Alert variant="destructive">
      <TriangleAlert />
      <AlertTitle>Tools couldn&apos;t be loaded</AlertTitle>
      <AlertDescription>
        {reason === "unauthorized" ? (
          <span>
            The request for this {owner}&apos;s tools wasn&apos;t authenticated.
            Try signing in again — if it keeps happening, the deployment&apos;s
            backend and frontend URLs are likely misconfigured.
          </span>
        ) : (
          <span>
            The tools for this {owner} are temporarily unreachable. Reload the
            page to try again.
          </span>
        )}
        <span>
          {hasExistingSelections
            ? "You can still edit and save this Agent; its existing tool selections are left unchanged."
            : "You can still create this Agent, then grant it tools once they load."}
        </span>
      </AlertDescription>
    </Alert>
  );
}
