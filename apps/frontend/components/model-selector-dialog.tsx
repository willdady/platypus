import { Agent, Provider } from "@platypus/schemas";
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
import { AgentAvatar } from "./agent-avatar";
import { Button } from "./ui/button";
import { getModelIds } from "@/lib/model-config";

const filterByKeywords = (
  _value: string,
  search: string,
  keywords?: string[],
) => {
  const haystack = (keywords ?? []).join(" ").toLowerCase();
  return haystack.includes(search.toLowerCase()) ? 1 : 0;
};

interface ModelSelectorDialogProps {
  agents: Agent[];
  providers: Provider[];
  agentId: string;
  modelId: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onModelChange: (value: string) => void;
}

export const ModelSelectorDialog = ({
  agents,
  providers,
  agentId,
  modelId,
  isOpen,
  onOpenChange,
  onModelChange,
}: ModelSelectorDialogProps) => {
  const selectedAgent = agentId ? agents.find((a) => a.id === agentId) : null;

  return (
    <ModelSelector open={isOpen} onOpenChange={onOpenChange}>
      <ModelSelectorTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="max-w-40 overflow-hidden sm:max-w-none"
        >
          {selectedAgent && (
            <AgentAvatar agent={selectedAgent} className="size-4" />
          )}
          <span className="truncate">
            {agentId
              ? selectedAgent?.name || "Select model"
              : modelId || "Select model"}
          </span>
        </Button>
      </ModelSelectorTrigger>
      <ModelSelectorContent filter={filterByKeywords}>
        <ModelSelectorInput placeholder="Search agents and models..." />
        <ModelSelectorList>
          <ModelSelectorEmpty>No results found.</ModelSelectorEmpty>
          {/* Agents Group */}
          {agents.length > 0 && (
            <ModelSelectorGroup heading="Agents">
              {agents.map((agent) => (
                <ModelSelectorItem
                  key={agent.id}
                  value={`agent:${agent.id}`}
                  keywords={[agent.name]}
                  className="cursor-pointer"
                  onSelect={() => {
                    onModelChange(`agent:${agent.id}`);
                    onOpenChange(false);
                  }}
                >
                  <AgentAvatar agent={agent} className="size-5" />
                  {agent.name}
                </ModelSelectorItem>
              ))}
            </ModelSelectorGroup>
          )}

          {/* Providers Group */}
          {providers.map((provider) => (
            <ModelSelectorGroup key={provider.id} heading={provider.name}>
              {getModelIds(provider).map((model) => (
                <ModelSelectorItem
                  key={`provider:${provider.id}:${model}`}
                  className="cursor-pointer"
                  value={`provider:${provider.id}:${model}`}
                  keywords={[model, provider.name]}
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
