import { Agent, Provider } from "@agent-kit/schemas";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorTrigger,
} from "./ai-elements/model-selector";
import { Button } from "./ui/button";

interface ModelSelectorDropdownProps {
  agents: Agent[];
  providers: Provider[];
  agentId: string;
  modelId: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onModelChange: (value: string) => void;
}

export const ModelSelectorDropdown = ({
  agents,
  providers,
  agentId,
  modelId,
  isOpen,
  onOpenChange,
  onModelChange,
}: ModelSelectorDropdownProps) => {
  const selectedAgent = agentId ? agents.find((a) => a.id === agentId) : null;

  return (
    <ModelSelector open={isOpen} onOpenChange={onOpenChange}>
      <ModelSelectorTrigger asChild>
        <Button variant="outline" size="sm" className="cursor-pointer">
          {agentId
            ? selectedAgent?.name || "Select model"
            : modelId || "Select model"}
        </Button>
      </ModelSelectorTrigger>
      <ModelSelectorContent>
        <ModelSelectorInput placeholder="Search models..." />
        <ModelSelectorList>
          <ModelSelectorEmpty>No results found.</ModelSelectorEmpty>
          {/* Agents Group */}
          {agents.length > 0 && (
            <ModelSelectorGroup heading="Agents">
              {agents.map((agent) => (
                <ModelSelectorItem
                  key={agent.id}
                  value={`agent:${agent.id}`}
                  className="cursor-pointer"
                  onSelect={() => {
                    onModelChange(`agent:${agent.id}`);
                    onOpenChange(false);
                  }}
                >
                  {agent.name}
                </ModelSelectorItem>
              ))}
            </ModelSelectorGroup>
          )}

          {/* Providers Group */}
          {providers.map((provider) => (
            <ModelSelectorGroup key={provider.id} heading={provider.name}>
              {provider.modelIds.map((model) => (
                <ModelSelectorItem
                  key={`provider:${provider.id}:${model}`}
                  className="cursor-pointer"
                  value={`provider:${provider.id}:${model}`}
                  onSelect={() => {
                    onModelChange(`provider:${provider.id}:${model}`);
                    onOpenChange(false);
                  }}
                >
                  {model}
                </ModelSelectorItem>
              ))}
            </ModelSelectorGroup>
          ))}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  );
};
