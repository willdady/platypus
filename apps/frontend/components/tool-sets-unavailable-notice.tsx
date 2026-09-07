import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { type ToolSetsFailureReason } from "@/lib/tool-sets-request";

/**
 * Shown in place of the Tools card when the tool sets couldn't be read.
 *
 * Deliberately distinct from the "this Workspace has no tool sets" case, which
 * renders nothing: substituting an empty list for a failed read hides the
 * misconfiguration that caused it (issue #818).
 */
export const ToolSetsUnavailableNotice = ({
  reason,
  scope,
  hasExistingSelections,
}: {
  reason: ToolSetsFailureReason;
  /** Which catalogue was being read — a Shared Agent reads the org's. */
  scope: "organization" | "workspace";
  /** Only an existing Agent has selections worth reassuring the reader about. */
  hasExistingSelections: boolean;
}) => {
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
};
