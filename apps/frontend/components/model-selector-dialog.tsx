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
import { findModelOption, getModelOptions } from "@/lib/model-config";
import {
  encodeAgentSelection,
  encodeProviderSelection,
} from "@/lib/selection-reference";
import { formatTokens } from "@/lib/context-window";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

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
  providerId: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onModelChange: (value: string) => void;
  /**
   * The resolved model's Output ceiling (issue #454), shown as a tooltip on
   * the trigger — the only reader this figure has today, so an Org Admin's
   * declaration is visible before a reply is cut short, not only after.
   */
  maxOutputTokens?: number;
}

export const ModelSelectorDialog = ({
  agents,
  providers,
  agentId,
  modelId,
  providerId,
  isOpen,
  onOpenChange,
  onModelChange,
  maxOutputTokens,
}: ModelSelectorDialogProps) => {
  const selectedAgent = agentId ? agents.find((a) => a.id === agentId) : null;

  // Label the trigger with what the picker shows, never the stored reference —
  // `alias:flagship` is a storage disambiguator and is never user-visible.
  const selectedProvider = providerId
    ? providers.find((p) => p.id === providerId)
    : undefined;
  const selectedModelLabel =
    selectedProvider && modelId
      ? findModelOption(selectedProvider, modelId)?.label
      : undefined;

  const trigger = (
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
          : selectedModelLabel || "Select model"}
      </span>
    </Button>
  );

  return (
    <ModelSelector open={isOpen} onOpenChange={onOpenChange}>
      {maxOutputTokens ? (
        <Tooltip delayDuration={1000}>
          <ModelSelectorTrigger asChild>
            <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          </ModelSelectorTrigger>
          <TooltipContent>
            Max reply length: {formatTokens(maxOutputTokens)} tokens
          </TooltipContent>
        </Tooltip>
      ) : (
        <ModelSelectorTrigger asChild>{trigger}</ModelSelectorTrigger>
      )}
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
                  value={encodeAgentSelection(agent.id)}
                  keywords={[agent.name]}
                  className="cursor-pointer"
                  onSelect={() => {
                    onModelChange(encodeAgentSelection(agent.id));
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
              {getModelOptions(provider).map((model) => (
                <ModelSelectorItem
                  key={encodeProviderSelection(provider.id, model.value)}
                  className="cursor-pointer"
                  value={encodeProviderSelection(provider.id, model.value)}
                  keywords={[model.label, provider.name]}
                  onSelect={() => {
                    onModelChange(
                      encodeProviderSelection(provider.id, model.value),
                    );
                    onOpenChange(false);
                  }}
                >
                  {model.label}
                </ModelSelectorItem>
              ))}
            </ModelSelectorGroup>
          ))}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  );
};
