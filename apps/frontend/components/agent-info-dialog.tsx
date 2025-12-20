import { Agent, ToolSet, Provider } from "@platypus/schemas";
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Label } from "./ui/label";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";
import { ChevronsUpDown, Pencil } from "lucide-react";
import { useState } from "react";
import { useParams, useRouter } from "next/navigation";

interface AgentInfoDialogProps {
  agent: Agent;
  toolSets: ToolSet[];
  providers: Provider[];
  onClose?: () => void;
}

export const AgentInfoDialog = ({
  agent,
  toolSets,
  providers,
  onClose,
}: AgentInfoDialogProps) => {
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
  const router = useRouter();
  const params = useParams();

  const orgId = params.orgId as string;
  const workspaceId = params.workspaceId as string;

  const provider = providers.find((p) => p.id === agent.providerId);

  const handleEdit = () => {
    router.push(`/${orgId}/workspace/${workspaceId}/agents/${agent.id}`);
  };

  return (
    <DialogContent
      className="sm:max-w-[600px] max-h-[80vh]"
      showCloseButton={false}
    >
      <DialogHeader>
        <DialogTitle>Agent Information</DialogTitle>
        <DialogDescription>
          View the configuration for this agent.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-4 py-4 max-h-[60vh] overflow-y-auto -mx-6 px-6">
        <div className="grid gap-2">
          <Label>Provider</Label>
          <div className="text-sm bg-muted p-2 rounded cursor-default">
            {provider?.name || "Unknown"}
          </div>
        </div>
        <div className="grid gap-2">
          <Label>Model</Label>
          <div className="text-sm font-mono bg-muted p-2 rounded cursor-default">
            {agent.modelId}
          </div>
        </div>
        <div className="grid gap-2">
          <Label>System Prompt</Label>
          <div className="text-sm bg-muted p-2 rounded whitespace-pre-wrap cursor-default">
            {agent.systemPrompt || "No system prompt set"}
          </div>
        </div>
        <div className="grid gap-2">
          <Label>Max Steps</Label>
          <div className="text-sm font-mono bg-muted p-2 rounded cursor-default">
            {agent.maxSteps ?? "Not set"}
          </div>
        </div>
        {toolSets.length > 0 &&
          agent.toolSetIds &&
          agent.toolSetIds.length > 0 && (
            <div className="grid gap-2">
              <Label>Tools</Label>
              <div className="flex flex-wrap gap-2">
                {agent.toolSetIds.map((id) => {
                  const toolSet = toolSets.find((ts) => ts.id === id);
                  return toolSet ? (
                    <Badge
                      key={id}
                      className="cursor-default"
                      variant="secondary"
                    >
                      {toolSet.name}
                    </Badge>
                  ) : null;
                })}
              </div>
            </div>
          )}
        <Collapsible open={isAdvancedOpen} onOpenChange={setIsAdvancedOpen}>
          <CollapsibleTrigger asChild>
            <div className="flex text-sm justify-between items-center">
              <span className="cursor-default">Advanced settings</span>
              <Button
                variant="ghost"
                size="icon"
                className="cursor-pointer size-8"
              >
                <ChevronsUpDown />
              </Button>
            </div>
          </CollapsibleTrigger>
          <CollapsibleContent className="mb-6">
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label>Temperature</Label>
                <div className="text-sm font-mono bg-muted p-2 rounded cursor-default">
                  {agent.temperature ?? "Not set"}
                </div>
              </div>
              <div className="grid gap-2">
                <Label>Seed</Label>
                <div className="text-sm font-mono bg-muted p-2 rounded cursor-default">
                  {agent.seed ?? "Not set"}
                </div>
              </div>
              <div className="grid gap-2">
                <Label>Top-p</Label>
                <div className="text-sm font-mono bg-muted p-2 rounded cursor-default">
                  {agent.topP ?? "Not set"}
                </div>
              </div>
              <div className="grid gap-2">
                <Label>Top-k</Label>
                <div className="text-sm font-mono bg-muted p-2 rounded cursor-default">
                  {agent.topK ?? "Not set"}
                </div>
              </div>
              <div className="grid gap-2">
                <Label>Presence Penalty</Label>
                <div className="text-sm font-mono bg-muted p-2 rounded cursor-default">
                  {agent.presencePenalty ?? "Not set"}
                </div>
              </div>
              <div className="grid gap-2">
                <Label>Frequency Penalty</Label>
                <div className="text-sm font-mono bg-muted p-2 rounded cursor-default">
                  {agent.frequencyPenalty ?? "Not set"}
                </div>
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
      <DialogFooter className="sm:justify-between">
        <Button
          variant="outline"
          className="cursor-pointer"
          onClick={handleEdit}
        >
          <Pencil className="size-4" /> Edit Agent
        </Button>
        <Button className="cursor-pointer" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </DialogContent>
  );
};
