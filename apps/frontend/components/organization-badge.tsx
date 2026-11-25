import { Building } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export function OrganizationBadge() {
  return (
    <Badge variant="pill">
      <Building />
      Organization
    </Badge>
  );
}
