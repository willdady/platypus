import { Pause } from "lucide-react";
import { Badge } from "@/components/ui/badge";

/** The title-row badge every disabled card wears (`card-conventions`). */
export const DisabledBadge = () => (
  <Badge variant="secondary" className="text-xs">
    <Pause />
    Disabled
  </Badge>
);
