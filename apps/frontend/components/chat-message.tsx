import { Fragment, memo, type ReactNode } from "react";
import { AgentAvatar } from "@/components/agent-avatar";
import {
  Message,
  MessageContent,
  MessageResponse,
  MessageActions,
  MessageAction,
  MessageAttachments,
  MessageAttachment,
} from "./ai-elements/message";
import {
  Sources,
  SourcesContent,
  SourcesTrigger,
  Source,
} from "./ai-elements/sources";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "./ai-elements/reasoning";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
  humanizeToolType,
} from "./ai-elements/tool";
import type {
  DynamicToolUIPart,
  FileUIPart,
  ReasoningUIPart,
  SourceUrlUIPart,
  TextUIPart,
  ToolUIPart,
} from "ai";
import { isToolUIPart, type ChatStatus } from "ai";
import remarkBreaks from "remark-breaks";
import { defaultRemarkPlugins } from "streamdown";
import type { Agent } from "@platypus/schemas";
import {
  formatFileSize,
  isPresentableUrl,
  type CustomUITools,
  type PlatypusUIMessage,
} from "@platypus/schemas";
import {
  isImageAttachment,
  messageSandboxUploads,
  messageText,
  toolErrorText,
} from "@/lib/message-parts";
import {
  FileIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PencilIcon,
  CopyIcon,
  TrashIcon,
  RefreshCwIcon,
} from "lucide-react";
import { toolCallDurationMs } from "@/lib/tool-duration";
import type { AlternativePosition } from "@/lib/chat-alternatives";
import { isTurnInFlight as isInFlight } from "@/lib/chat-recovery";
import { ResponseMetricsPopover } from "./response-metrics-popover";
import { TurnNotice } from "./turn-notice";
import { TurnStatus } from "./turn-status";
import { MessagePartBoundary } from "./message-part-boundary";
import { LoadSkillTool, ReadSkillFileTool } from "./load-skill-tool";
import { SubAgentTool } from "./sub-agent-tool";
import {
  ArtifactToolCard,
  isArtifactToolPart,
  replyArtifacts,
  storedArtifactOf,
  type ArtifactOpenTarget,
} from "./artifact-tool-card";
import { ToolApprovalCard } from "./tool-approval-card";
import { OfferedFiles, offeredFiles } from "./offered-files";
import {
  WebToolCard,
  isNormalizedWebToolPart,
  normalizedWebTool,
  webSearchSources,
  webToolTitle,
} from "./web-search-tool";
import { ToolCallGroup, partitionParts } from "./tool-call-group";
import type { Serialized } from "@/lib/api-write";

export const CUT_SHORT_NOTICE =
  "Response cut short at the model's output limit.";

export const STEP_LIMIT_NOTICE =
  "Response cut short at the step limit. Raise Max steps to let it finish.";

// why: the model is never told search failed; this is the only sign
export const SEARCH_UNAVAILABLE_NOTICE =
  "Search was unavailable — this reply was written without it.";

type MessagePart = NonNullable<PlatypusUIMessage["parts"]>[number];

type MessageToolPart = ToolUIPart<CustomUITools>;

type PartOfType<T extends MessagePart["type"]> = Extract<
  MessagePart,
  { type: T }
>;

// why: remark-breaks needs Streamdown's defaults kept, since passing plugins replaces them
const userRemarkPlugins = [
  ...Object.values(defaultRemarkPlugins),
  remarkBreaks,
];

function isTextPart(part: MessagePart): part is TextUIPart {
  return part.type === "text";
}

function isReasoningPart(part: MessagePart): part is ReasoningUIPart {
  return part.type === "reasoning";
}

function isTranscriptSummaryStatusPart(
  part: MessagePart,
): part is PartOfType<"data-transcript-summary-status"> {
  return part.type === "data-transcript-summary-status";
}

function isDynamicToolPart(part: MessagePart): part is DynamicToolUIPart {
  return part.type === "dynamic-tool";
}

function isLoadSkillPart(
  part: MessagePart,
): part is PartOfType<"tool-loadSkill"> {
  return part.type === "tool-loadSkill";
}

function isReadSkillFilePart(
  part: MessagePart,
): part is PartOfType<"tool-readSkillFile"> {
  return part.type === "tool-readSkillFile";
}

function isSubAgentToolPart(part: MessagePart): part is MessageToolPart {
  return (
    isToolUIPart(part) &&
    (part.type === "tool-delegate" || part.type.startsWith("tool-delegateTo"))
  );
}

// why: only a call that reached output has a file to offer; others fall through
const OFFER_STATES = new Set([
  "input-streaming",
  "input-available",
  "output-available",
]);
function isOfferedFilePart(
  part: MessagePart,
): part is PartOfType<"tool-fsDownload"> {
  return part.type === "tool-fsDownload" && OFFER_STATES.has(part.state);
}

function isWebToolPart(part: MessagePart): part is MessageToolPart {
  return isToolUIPart(part) && isNormalizedWebToolPart(part);
}

// why: a write that stored nothing stays in the body as a card
function isStoredArtifactPart(part: MessagePart): boolean {
  return isArtifactToolPart(part) && storedArtifactOf(part) !== undefined;
}

// why: one list, so isGenericToolPart excludes these without restating them
const specializedToolMatchers: Array<(part: MessagePart) => boolean> = [
  isLoadSkillPart,
  isReadSkillFilePart,
  isWebToolPart,
  isSubAgentToolPart,
  isArtifactToolPart,
  isOfferedFilePart,
];

export function isGenericToolPart(part: MessagePart): part is MessageToolPart {
  return (
    isToolUIPart(part) &&
    !specializedToolMatchers.some((matches) => matches(part))
  );
}

// why: sub-agent, artifact and approval cards stand alone; each ends the group
function isGroupableToolPart(
  part: MessagePart,
): part is MessageToolPart | DynamicToolUIPart {
  return (
    isToolUIPart(part) &&
    !isSubAgentToolPart(part) &&
    !isArtifactToolPart(part) &&
    part.state !== "approval-requested"
  );
}

function toolCallName(part: MessageToolPart | DynamicToolUIPart): string {
  if (isDynamicToolPart(part)) return part.toolName;
  const web = normalizedWebTool(part);
  return web ? webToolTitle(web.kind) : humanizeToolType(part.type);
}

function toolCallErrored(part: MessagePart): boolean {
  if (isLoadSkillPart(part) || isReadSkillFilePart(part)) {
    // why: a truncated result arrives as a string, whatever its type says
    const output: unknown = part.output;
    return !!(
      part.errorText ||
      (output && typeof output === "object" && "error" in output)
    );
  }
  if (isWebToolPart(part)) {
    return !!(part.errorText ?? normalizedWebTool(part)?.error);
  }
  return (
    isToolUIPart(part) &&
    (part.state === "output-error" || part.state === "output-denied")
  );
}

// why: a denial answered by a newer message keeps its answered state for good
function shownAsDenied(part: MessagePart): MessagePart {
  return isToolUIPart(part) &&
    part.state === "approval-responded" &&
    !part.approval.approved
    ? ({ ...part, state: "output-denied" } as MessagePart)
    : part;
}

function isImageFilePart(part: MessagePart): part is FileUIPart {
  return part.type === "file" && isImageAttachment(part);
}

type PartRenderer = {
  matches: (part: MessagePart) => boolean;
  render: (part: MessagePart, i: number) => ReactNode;
};

function partRenderer<P extends MessagePart>(
  matches: (part: MessagePart) => part is P,
  render: (part: P, i: number) => ReactNode,
): PartRenderer {
  return {
    matches,
    render: (part, i) => (matches(part) ? render(part, i) : null),
  };
}

type ToolPartCardProps = {
  part: MessageToolPart | DynamicToolUIPart;
  messageMetadata: PlatypusUIMessage["metadata"];
  // why: an MCP name is its identity; ToolHeader truncates a long one
  title?: string;
  label?: string;
  cleared?: boolean;
};

function ToolPartCard({
  part,
  messageMetadata,
  title,
  label,
  cleared,
}: ToolPartCardProps) {
  return (
    <Tool>
      <ToolHeader
        state={part.state}
        type={part.type}
        title={title}
        label={label}
        durationMs={toolCallDurationMs(
          part.toolMetadata,
          messageMetadata,
          part.toolCallId,
        )}
        cleared={cleared}
      />
      <ToolContent>
        <ToolInput input={part.input} />
        <ToolOutput output={part.output} errorText={toolErrorText(part)} />
      </ToolContent>
    </Tool>
  );
}

type ChatMessageProps = {
  message: PlatypusUIMessage;
  isLastMessage: boolean;
  status: ChatStatus;
  // why: gates transcript writes; Copy and metrics are reads
  canSendMessages: boolean;
  // why: the editor replaces the message; it shows parts, attachments and actions itself
  editor?: ReactNode;
  agents: Serialized<Agent>[];
  onEditStart: (messageId: string) => void;
  onMessageDelete: (messageId: string) => void;
  onRegenerate?: (messageId: string) => void;
  alternatives?: AlternativePosition;
  onSwitchAlternative: (fromId: string, toId: string) => void;
  onCopyMessage: (content: string, messageId: string) => void;
  // why: per message, so copying one leaves every other memo intact
  copied: boolean;
  // why: derived per render from occupancy, never persisted (ADR-0018)
  staleToolCallIds?: ReadonlySet<string>;
  // why: only the Active leaf with no turn running can resume the reply
  onApprovalResponse?: (approvalId: string, approved: boolean) => void;
  artifactScope?: { orgId: string; workspaceId: string };
  onOpenArtifact?: (target: ArtifactOpenTarget) => void;
};

export const ChatMessage = memo(function ChatMessage({
  message,
  isLastMessage,
  status,
  canSendMessages,
  editor,
  agents,
  onEditStart,
  onMessageDelete,
  onRegenerate,
  alternatives,
  onSwitchAlternative,
  onCopyMessage,
  copied,
  staleToolCallIds,
  onApprovalResponse,
  artifactScope,
  onOpenArtifact,
}: ChatMessageProps) {
  // why: the editor shows them itself, so rendering them here duplicates them
  if (editor) {
    return (
      <div key={message.id} className="w-full">
        {editor}
      </div>
    );
  }

  const messageAgentId = message.metadata?.agentId;
  const messageAgent = messageAgentId
    ? agents.find((a) => a.id === messageAgentId)
    : undefined;
  // why: only the first part names the agent, or a screen reader repeats it per part
  const firstAvatarPart = message.parts?.findIndex(
    (part) => part.type === "text" || isImageFilePart(part),
  );
  const assistantAvatar = (partIndex: number) =>
    message.role === "assistant" &&
    (messageAgent ? (
      <AgentAvatar
        agent={messageAgent}
        className="size-6"
        alt={partIndex === firstAvatarPart ? messageAgent.name : ""}
      />
    ) : (
      <AgentAvatar agent={{ name: "" }} className="size-6" />
    ));
  const fileParts = message.parts?.filter(
    (part): part is FileUIPart =>
      part.type === "file" && !isImageFilePart(part),
  );
  // why: titled by the vendor, a javascript: or data: citation would look ordinary
  const sourceUrlParts = message.parts?.filter(
    (part): part is SourceUrlUIPart =>
      part.type === "source-url" && isPresentableUrl(part.url),
  );
  // why: backend search citations join the one Sources row (ADR-0014)
  const pluginSearchSources = webSearchSources(message.parts);
  // why: the vetted plugin pill wins; exact strings, so no URL normalising
  const pluginSearchUrls = new Set(pluginSearchSources.map((s) => s.url));
  const nativeSourceParts = sourceUrlParts?.filter(
    (part) => !pluginSearchUrls.has(part.url),
  );
  const sourceCount =
    (nativeSourceParts?.length ?? 0) + pluginSearchSources.length;

  const textContent = messageText(message.parts);
  const sandboxUploads = messageSandboxUploads(message.parts);

  // why: matches are mutually exclusive, so order doesn't matter
  const isTurnInFlight = isInFlight(status);
  const isAwaitedReply =
    message.role === "assistant" && isLastMessage && isTurnInFlight;

  const partRenderers: PartRenderer[] = [
    // why: only the in-flight turn shows it; the composer is the live region (ADR-0023)
    partRenderer(isTranscriptSummaryStatusPart, (statusPart, i) =>
      isAwaitedReply ? (
        <TurnStatus
          key={`${message.id}-${i}`}
          announce={false}
          className="pl-8"
        >
          {statusPart.data.text}
        </TurnStatus>
      ) : null,
    ),
    partRenderer(isTextPart, (textPart, i) => (
      <Message
        key={`${message.id}-${i}`}
        from={message.role}
        avatar={assistantAvatar(i)}
      >
        <MessageContent className="max-w-full">
          <MessageResponse
            remarkPlugins={
              message.role === "user" ? userRemarkPlugins : undefined
            }
          >
            {textPart.text}
          </MessageResponse>
        </MessageContent>
      </Message>
    )),
    partRenderer(isReasoningPart, (reasoningPart, i) => (
      <Reasoning
        key={`${message.id}-${i}`}
        isStreaming={
          status === "streaming" &&
          i === (message.parts?.length ?? 0) - 1 &&
          isLastMessage
        }
        defaultOpen={false}
      >
        <ReasoningTrigger />
        <ReasoningContent>{reasoningPart.text}</ReasoningContent>
      </Reasoning>
    )),
    partRenderer(isDynamicToolPart, (toolPart, i) => (
      <ToolPartCard
        key={`${message.id}-${i}`}
        part={toolPart}
        messageMetadata={message.metadata}
        title={toolPart.toolName}
      />
    )),
    partRenderer(isLoadSkillPart, (part, i) => (
      <LoadSkillTool key={`${message.id}-${i}`} toolPart={part} />
    )),
    partRenderer(isReadSkillFilePart, (part, i) => (
      <ReadSkillFileTool key={`${message.id}-${i}`} toolPart={part} />
    )),
    partRenderer(isWebToolPart, (part, i) => (
      <WebToolCard
        key={`${message.id}-${i}`}
        toolPart={part}
        messageMetadata={message.metadata}
        cleared={staleToolCallIds?.has(part.toolCallId)}
      />
    )),
    partRenderer(isArtifactToolPart, (part, i) => (
      <ArtifactToolCard
        key={`${message.id}-${i}`}
        toolPart={part}
        scope={artifactScope}
        onOpen={(target) => onOpenArtifact?.(target)}
      />
    )),
    partRenderer(isSubAgentToolPart, (part, i) => (
      <SubAgentTool
        key={`${message.id}-${i}`}
        toolPart={part}
        messageMetadata={message.metadata}
      />
    )),
    partRenderer(isGenericToolPart, (toolPart, i) => {
      const toolInput = toolPart.input as Record<string, unknown> | undefined;
      const toolLabel = (toolInput?.label ?? toolInput?.name) as
        string | undefined;
      return (
        <ToolPartCard
          key={`${message.id}-${i}`}
          part={toolPart}
          messageMetadata={message.metadata}
          label={toolLabel}
          cleared={staleToolCallIds?.has(toolPart.toolCallId)}
        />
      );
    }),
    // why: a backend or data: URL can't go through the Next image optimizer
    partRenderer(isImageFilePart, (filePart, i) => (
      <Message
        key={`${message.id}-${i}`}
        from={message.role}
        avatar={assistantAvatar(i)}
      >
        <MessageContent className="max-w-full">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={filePart.url}
            alt={filePart.filename || "Generated image"}
            className="max-w-full rounded-lg border"
            loading={isLastMessage ? "eager" : "lazy"}
            decoding="async"
          />
        </MessageContent>
      </Message>
    )),
  ];

  // why: a held call has nothing to show until it runs, whatever the tool
  const renderApproval = (part: MessagePart) => {
    if (!isToolUIPart(part) || part.state !== "approval-requested") return null;
    const approvalId = part.approval.id;
    return (
      <ToolApprovalCard
        name={toolCallName(part)}
        type={part.type}
        input={part.input}
        reason={part.approval.requestReason}
        onRespond={
          onApprovalResponse &&
          ((approved) => onApprovalResponse(approvalId, approved))
        }
      />
    );
  };

  const renderPart = (part: MessagePart, i: number) => {
    const approval = renderApproval(part);
    const renderer = partRenderers.find((r) => r.matches(part));
    const render = approval
      ? () => approval
      : renderer && (() => renderer.render(part, i));
    return render ? (
      <MessagePartBoundary
        key={`${message.id}-${i}`}
        resetKey={part}
        render={render}
      />
    ) : null;
  };
  // why: an artifact moves to the tray only once the reply is finished
  const hiddenFromBody = (part: MessagePart) =>
    isOfferedFilePart(part) || (!isAwaitedReply && isStoredArtifactPart(part));
  const segments = partitionParts(
    (message.parts ?? []).map(shownAsDenied),
    isGroupableToolPart,
    hiddenFromBody,
  );
  const files = offeredFiles(message.parts ?? []);
  const artifacts = replyArtifacts(message.parts ?? []);
  // why: named for what it sits under, never version or branch (ADR-0026)
  const alternativeNoun = message.role === "user" ? "Message" : "Response";
  const alternativeLabel =
    alternatives &&
    `${alternativeNoun} ${alternatives.index + 1} of ${alternatives.count}`;

  return (
    <Fragment key={message.id}>
      {fileParts && fileParts.length > 0 && (
        <MessageAttachments key={`${message.id}-attachments`}>
          {fileParts.map((part, i) => (
            <MessageAttachment key={`${message.id}-${i}`} data={part} />
          ))}
        </MessageAttachments>
      )}
      {sandboxUploads.length > 0 && (
        // why: a link would serve the path's current bytes, not the upload (ADR-0028)
        <MessageAttachments key={`${message.id}-sandbox-uploads`}>
          {sandboxUploads.map((upload, i) => (
            <div
              key={`${message.id}-sandbox-${i}`}
              className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
              role="group"
              aria-label={`Sandbox upload ${upload.path}`}
            >
              <FileIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="font-mono font-medium">{upload.path}</span>
              <span className="text-muted-foreground text-xs">
                {formatFileSize(upload.size)}
              </span>
              <span className="rounded bg-muted px-1 text-muted-foreground text-xs">
                Sandbox
              </span>
            </div>
          ))}
        </MessageAttachments>
      )}
      {message.role === "assistant" && sourceCount > 0 && (
        <Sources>
          <SourcesTrigger count={sourceCount} />
          {nativeSourceParts?.map((part, i) => (
            <SourcesContent key={`${message.id}-${i}`}>
              <Source href={part.url} title={part.title || part.url} />
            </SourcesContent>
          ))}
          {pluginSearchSources.map((source) => (
            <SourcesContent key={`${message.id}-search-${source.url}`}>
              <Source href={source.url} title={source.title} />
            </SourcesContent>
          ))}
        </Sources>
      )}
      {segments.map((segment, segmentIndex) => {
        if (segment.kind === "part")
          return renderPart(segment.part, segment.index);
        const calls = segment.entries.map(({ part }) => part);
        return (
          <ToolCallGroup
            key={`${message.id}-${segment.entries[0].index}`}
            names={calls.map(toolCallName)}
            errored={calls.some(toolCallErrored)}
            active={isAwaitedReply && segmentIndex === segments.length - 1}
          >
            {segment.entries.map(({ part, index }) => renderPart(part, index))}
          </ToolCallGroup>
        );
      })}
      {message.role === "assistant" && (
        <>
          {message.metadata?.searchUnavailable && (
            <TurnNotice className="pl-8">
              {SEARCH_UNAVAILABLE_NOTICE}
            </TurnNotice>
          )}
          {message.metadata?.truncatedByTokenLimit && (
            <TurnNotice className="pl-8">{CUT_SHORT_NOTICE}</TurnNotice>
          )}
          {message.metadata?.stoppedAtStepLimit && (
            <TurnNotice className="pl-8">{STEP_LIMIT_NOTICE}</TurnNotice>
          )}
        </>
      )}
      {!isAwaitedReply && (files.length > 0 || artifacts.length > 0) && (
        <OfferedFiles
          files={files}
          artifacts={artifacts}
          scope={artifactScope}
          onOpen={onOpenArtifact}
        />
      )}
      {!isAwaitedReply && (
        <MessageActions
          className={message.role === "user" ? "justify-end" : "pl-8"}
        >
          {canSendMessages && alternatives && (
            <div
              role="group"
              aria-label={alternativeLabel}
              className="flex items-center"
            >
              <MessageAction
                className="text-muted-foreground"
                disabled={isTurnInFlight || !alternatives.previousId}
                onClick={() =>
                  onSwitchAlternative(message.id, alternatives.previousId!)
                }
                variant="ghost"
                size="icon"
                label={`Previous ${alternativeNoun.toLowerCase()}`}
              >
                <ChevronLeftIcon className="size-4" />
              </MessageAction>
              <span className="cursor-default text-xs tabular-nums text-muted-foreground">
                {alternatives.index + 1}/{alternatives.count}
              </span>
              <MessageAction
                className="text-muted-foreground"
                disabled={isTurnInFlight || !alternatives.nextId}
                onClick={() =>
                  onSwitchAlternative(message.id, alternatives.nextId!)
                }
                variant="ghost"
                size="icon"
                label={`Next ${alternativeNoun.toLowerCase()}`}
              >
                <ChevronRightIcon className="size-4" />
              </MessageAction>
            </div>
          )}
          {message.role === "assistant" && (
            // why: not beside Delete, so a frequent control doesn't invite mis-clicks
            <ResponseMetricsPopover metadata={message.metadata} />
          )}
          {canSendMessages && message.role === "user" && (
            <MessageAction
              className="text-muted-foreground"
              onClick={() => onEditStart(message.id)}
              variant="ghost"
              size="icon"
              label="Edit"
            >
              <PencilIcon className="size-4" />
            </MessageAction>
          )}
          <MessageAction
            className="text-muted-foreground"
            onClick={() => onCopyMessage(textContent, message.id)}
            variant={copied ? "secondary" : "ghost"}
            size="icon"
            label="Copy"
          >
            <CopyIcon className="size-4" />
          </MessageAction>
          {canSendMessages && (
            <MessageAction
              className="text-muted-foreground"
              onClick={() => onMessageDelete(message.id)}
              variant="ghost"
              size="icon"
              label="Delete"
            >
              <TrashIcon className="size-4" />
            </MessageAction>
          )}
          {canSendMessages && message.role === "assistant" && onRegenerate && (
            <MessageAction
              className="text-muted-foreground"
              // why: a second turn can't start while one runs, and would cut this reply off
              disabled={isTurnInFlight}
              onClick={() => onRegenerate(message.id)}
              variant="ghost"
              size="icon"
              label="Regenerate"
            >
              <RefreshCwIcon className="size-4" />
            </MessageAction>
          )}
        </MessageActions>
      )}
    </Fragment>
  );
});
