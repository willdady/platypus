import { Pause } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export function DisabledBadge() {
  return (
    <Badge variant="secondary" className="text-xs">
      <Pause />
      Disabled
    </Badge>
  );
}
