import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { type ToolSetsFailureReason } from "@/lib/tool-sets-request";

/**
 * Shown in place of the Tools card when the tool sets couldn't be read.
 *
 * Deliberately distinct from the "this workspace has no tool sets" case, which
 * renders nothing: substituting an empty list for a failed read hides the
 * misconfiguration that caused it (issue #818).
 */
export const ToolSetsUnavailableNotice = ({
  reason,
}: {
  reason: ToolSetsFailureReason;
}) => (
  <Alert variant="destructive">
    <TriangleAlert />
    <AlertTitle>Tools couldn&apos;t be loaded</AlertTitle>
    <AlertDescription>
      {reason === "unauthorized" ? (
        <span>
          The request for this workspace&apos;s tools wasn&apos;t authenticated.
          Try signing in again — if it keeps happening, the deployment&apos;s
          backend and frontend URLs are likely misconfigured.
        </span>
      ) : (
        <span>
          The tools for this workspace are temporarily unreachable. Reload the
          page to try again.
        </span>
      )}
      <span>
        You can still edit and save this Agent; its existing tool selections are
        left unchanged.
      </span>
    </AlertDescription>
  </Alert>
);
