import { createElement } from "react";
import { Button } from "@/components/ui/button";
import {
  getToolIcon,
  ToolInput,
  ToolStatus,
  toolRowClassName,
  toolRowIconSlotClassName,
} from "./ai-elements/tool";

export function ToolApprovalCard({
  name,
  type,
  input,
  reason,
  onRespond,
}: {
  name: string;
  type: string;
  input: unknown;
  reason?: string;
  // why: absent off the Active leaf or mid-turn — a reply there cannot be resumed
  onRespond?: (approved: boolean) => void;
}) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-3 rounded-lg border p-3">
      <div className={toolRowClassName}>
        <span className={toolRowIconSlotClassName}>
          {createElement(getToolIcon(type), { className: "size-4" })}
        </span>
        <span className="min-w-0 truncate select-text text-foreground">
          {name}
        </span>
        <ToolStatus state="approval-requested" />
      </div>
      <div className="flex flex-col gap-3 pl-8 text-sm">
        {reason && <p className="text-foreground">{reason}</p>}
        <ToolInput input={input} />
        {onRespond && (
          <div className="flex gap-2">
            <Button size="sm" onClick={() => onRespond(true)}>
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onRespond(false)}
            >
              Deny
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
