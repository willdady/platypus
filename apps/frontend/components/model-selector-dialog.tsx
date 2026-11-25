import { useMemo, type MouseEvent } from "react";
import type { Agent, Provider } from "@platypus/schemas";
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
import { Skeleton } from "./ui/skeleton";
import { findModelOption, getModelOptions } from "@/lib/model-config";
import {
  encodeAgentSelection,
  encodeProviderSelection,
} from "@/lib/selection-reference";
import { formatTokens } from "@/lib/context-window";
import { splitPinned } from "@/lib/pinned-agents";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import type { Serialized } from "@/lib/api-write";

function filterByKeywords(_value: string, search: string, keywords?: string[]) {
  const haystack = (keywords ?? []).join(" ").toLowerCase();
  return haystack.includes(search.toLowerCase()) ? 1 : 0;
}

// why: preventDefault on mousedown — focus must stay editable or Android drops the keyboard
function keepFocus(event: MouseEvent) {
  return event.preventDefault();
}

type ModelSelectorDialogProps = {
  agents: Serialized<Agent>[];
  providers: Serialized<Provider>[];
  agentId: string;
  modelId: string;
  providerId: string;
  isResolved: boolean;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onModelChange: (value: string) => void;
  maxOutputTokens?: number;
  onCloseAutoFocus?: (event: Event) => void;
  lockedReason?: string;
};

// why: unresolved shows a neutral label — 'Select model' then correcting is the flicker
export function ModelSelectorDialog({
  agents,
  providers,
  agentId,
  modelId,
  providerId,
  isResolved,
  isOpen,
  onOpenChange,
  onModelChange,
  maxOutputTokens,
  onCloseAutoFocus,
  lockedReason,
}: ModelSelectorDialogProps) {
  const selectedAgent = agentId ? agents.find((a) => a.id === agentId) : null;

  const providerOptions = useMemo(
    () =>
      providers.map((provider) => ({
        provider,
        options: getModelOptions(provider),
      })),
    [providers],
  );

  const selectedProvider = providerId
    ? providers.find((p) => p.id === providerId)
    : undefined;
  // why: label from the picker, never alias:flagship — that is storage, not a name
  const selectedModelLabel = useMemo(() => {
    const label =
      selectedProvider && modelId
        ? findModelOption(selectedProvider, modelId)?.label
        : undefined;
    if (!selectedProvider || !label) return label;
    const offeredBy = providerOptions.filter(({ options }) =>
      options.some((option) => option.label === label),
    ).length;
    return offeredBy > 1 ? `${label} · ${selectedProvider.name}` : label;
  }, [selectedProvider, modelId, providerOptions]);

  // why: not bg-accent — that is the outline button's hover fill, so the bar vanishes
  const trigger = (
    <Button
      variant="outline"
      size="sm"
      className="max-w-40 overflow-hidden sm:max-w-none"
      onMouseDown={keepFocus}
      aria-busy={!isResolved || undefined}
      disabled={Boolean(lockedReason)}
    >
      {isResolved ? (
        <>
          {selectedAgent && (
            <AgentAvatar agent={selectedAgent} className="size-4" />
          )}
          <span className="truncate">
            {agentId
              ? selectedAgent?.name || "Select model"
              : selectedModelLabel || "Select model"}
          </span>
        </>
      ) : (
        <Skeleton
          className="h-4 w-28 bg-foreground/10"
          aria-label="Loading selection"
        />
      )}
    </Button>
  );

  const { pinned: pinnedAgents, unpinned: unpinnedAgents } =
    splitPinned(agents);
  const renderAgentItem = (agent: Serialized<Agent>) => (
    <ModelSelectorItem
      key={agent.id}
      value={encodeAgentSelection(agent.id)}
      keywords={[agent.name]}
      onMouseDown={keepFocus}
      onSelect={() => {
        onModelChange(encodeAgentSelection(agent.id));
        onOpenChange(false);
      }}
    >
      <AgentAvatar agent={agent} className="size-5" />
      {agent.name}
    </ModelSelectorItem>
  );

  // why: the tooltip hangs off a wrapper — a disabled button takes no pointer events
  if (lockedReason) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0}>{trigger}</span>
        </TooltipTrigger>
        <TooltipContent>{lockedReason}</TooltipContent>
      </Tooltip>
    );
  }

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
      <ModelSelectorContent
        filter={filterByKeywords}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <ModelSelectorInput placeholder="Search agents and models..." />
        <ModelSelectorList>
          <ModelSelectorEmpty>No results found.</ModelSelectorEmpty>
          {pinnedAgents.length > 0 && (
            <ModelSelectorGroup heading="Pinned">
              {pinnedAgents.map(renderAgentItem)}
            </ModelSelectorGroup>
          )}
          {unpinnedAgents.length > 0 && (
            <ModelSelectorGroup heading="Agents">
              {unpinnedAgents.map(renderAgentItem)}
            </ModelSelectorGroup>
          )}

          {providerOptions.map(({ provider, options }) => (
            <ModelSelectorGroup key={provider.id} heading={provider.name}>
              {options.map((model) => (
                <ModelSelectorItem
                  key={encodeProviderSelection(provider.id, model.value)}
                  value={encodeProviderSelection(provider.id, model.value)}
                  keywords={[model.label, provider.name]}
                  onMouseDown={keepFocus}
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
}
