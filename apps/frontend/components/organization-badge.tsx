import { Building } from "lucide-react";
import { Badge } from "@/components/ui/badge";

/** Marks a Shared resource attached to a Workspace (ADR-0007). */
export function OrganizationBadge() {
  return (
    <Badge variant="pill">
      <Building />
      Organization
    </Badge>
  );
}
