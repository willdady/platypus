"use client";

import { Badge } from "@/components/ui/badge";

export function KanbanLabelBadge({
  name,
  color,
}: {
  name: string;
  color: string;
}) {
  return (
    <Badge className="border-0" style={{ backgroundColor: color }}>
      {name}
    </Badge>
  );
}
