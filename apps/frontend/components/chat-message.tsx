import { Fragment, memo } from "react";
import { type PlatypusUIMessage } from "@platypus/backend/src/types";
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
} from "./ai-elements/tool";
import { DynamicToolHeader } from "./dynamic-tool-header";
import {
  DynamicToolUIPart,
  FileUIPart,
  SourceUrlUIPart,
  TextUIPart,
  isToolUIPart,
  type ChatStatus,
} from "ai";
import { Agent, isPresentableUrl } from "@platypus/schemas";
import {
  BotIcon,
  CheckIcon,
  PencilIcon,
  CopyIcon,
  TrashIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import { Textarea } from "./ui/textarea";
import { toolCallDurationMs } from "@/lib/tool-duration";
import { CutShortNotice } from "./cut-short-notice";
import { LoadSkillTool } from "./load-skill-tool";
import { SubAgentTool } from "./sub-agent-tool";
import {
  WebSearchTool,
  isPluginWebSearchPart,
  webSearchSources,
} from "./web-search-tool";

/**
 * What the person reading a reply is told when it stopped at the model's
 * output ceiling rather than because the model was finished. A constant so
 * tests assert the wording without restating the prose.
 */
export const CUT_SHORT_NOTICE =
  "Response cut short at the model's output limit.";

interface ChatMessageProps {
  /** The message object to render */
  message: PlatypusUIMessage;
  /** Whether this is the last message in the conversation */
  isLastMessage: boolean;
  /** Current chat status from useChat hook */
  status: ChatStatus;
  /** Whether this message is currently being edited */
  isEditing: boolean;
  /** Current content of the message being edited */
  editContent: string;
  /** Ref to the textarea element for editing */
  editTextareaRef: React.RefObject<HTMLTextAreaElement | null>;
  /** Available agents for resolving avatars */
  agents: Agent[];
  /** Callback to update the edit content */
  setEditContent: (content: string) => void;
  /** Callback when user starts editing a message */
  onEditStart: (messageId: string, content: string) => void;
  /** Callback when user cancels editing */
  onEditCancel: () => void;
  /** Callback when user submits edited message */
  onEditSubmit: () => void;
  /** Callback when user deletes a message */
  onMessageDelete: (messageId: string) => void;
  /** Callback when user regenerates the last assistant message */
  onRegenerate: () => void;
  /** Callback when user copies message content */
  onCopyMessage: (content: string, messageId: string) => void;
  /** ID of the message that was recently copied, or null */
  copiedMessageId: string | null;
}

export const ChatMessage = memo(function ChatMessage({
  message,
  isLastMessage,
  status,
  isEditing,
  editContent,
  editTextareaRef,
  agents,
  setEditContent,
  onEditStart,
  onEditCancel,
  onEditSubmit,
  onMessageDelete,
  onRegenerate,
  onCopyMessage,
  copiedMessageId,
}: ChatMessageProps) {
  const messageAgentId = message.metadata?.agentId;
  const messageAgent = messageAgentId
    ? agents.find((a) => a.id === messageAgentId)
    : undefined;
  const assistantAvatar =
    message.role === "assistant" &&
    (messageAgent?.avatarUrl ? (
      // Agent avatar URL is user-supplied (arbitrary host); not routable
      // through the Next image optimizer.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={messageAgent.avatarUrl}
        alt={messageAgent.name}
        className="size-6 rounded-full object-cover"
      />
    ) : (
      <div className="flex size-6 items-center justify-center rounded-full bg-muted">
        <BotIcon className="size-3.5 text-muted-foreground" />
      </div>
    ));
  const fileParts = message.parts?.filter(
    (part): part is FileUIPart =>
      part.type === "file" && !part.mediaType?.startsWith("image/"),
  );
  // Scheme-checked with the same predicate a plugin result's URL goes through.
  // A vendor is more trusted than a Web-search backend, but the pill is titled by
  // the vendor's own title now, so a `javascript:` or `data:` citation would render
  // as an ordinary-looking link with nothing on screen to give it away — the raw URL
  // used to be the label, which was the only thing making one visible.
  const sourceUrlParts = message.parts?.filter(
    (part): part is SourceUrlUIPart =>
      part.type === "source-url" && isPresentableUrl(part.url),
  );
  // Citations from a Web-search backend's client-executed `web_search`, which
  // arrive as a tool result rather than as `source-url` parts. Merged into the one
  // Sources row below so the same Chat toggle presents its results the same way on
  // a vLLM Provider as on Anthropic (ADR-0014).
  const pluginSearchSources = webSearchSources(message.parts);
  // A page named by both rows is one pill. Not reachable through search
  // resolution — a turn resolves to a backend or to native search, never both
  // (ADR-0014) — but a vendor emits `source-url` parts for citations that are not
  // search results, and those can land in the same message as a backend search.
  //
  // The plugin entry is the one kept: both rows carry a real title, but the plugin
  // URL has been through core's own presentability rules on the way in, so where the
  // two disagree the vetted copy is the safer pill. Compared as exact strings, so a
  // vendor URL differing by a trailing slash or a tracking parameter still reads as
  // a second page — normalising URLs is a judgement call of its own and belongs
  // with whoever asks for it.
  const pluginSearchUrls = new Set(pluginSearchSources.map((s) => s.url));
  const nativeSourceParts = sourceUrlParts?.filter(
    (part) => !pluginSearchUrls.has(part.url),
  );
  const sourceCount =
    (nativeSourceParts?.length ?? 0) + pluginSearchSources.length;

  const textContent =
    message.parts
      ?.filter((part): part is TextUIPart => part.type === "text")
      .map((part) => part.text)
      .join("") || "";

  return (
    <Fragment key={message.id}>
      {fileParts && fileParts.length > 0 && (
        <MessageAttachments key={`${message.id}-attachments`}>
          {fileParts.map((part, i) => (
            <MessageAttachment key={`${message.id}-${i}`} data={part} />
          ))}
        </MessageAttachments>
      )}
      {message.role === "assistant" && sourceCount > 0 && (
        <Sources>
          <SourcesTrigger count={sourceCount} />
          {nativeSourceParts?.map((part, i) => (
            <SourcesContent key={`${message.id}-${i}`}>
              {/* A `source-url` part carries an optional title and Anthropic
              sends one; the URL is the fallback for a vendor that does not, not
              the label. Without this a native Provider shows raw URLs where a
              backend Provider shows real titles, in the same row.
              `||`, not `??`: a vendor sending an empty title would otherwise
              render a pill with no label at all. */}
              <Source href={part.url} title={part.title || part.url} />
            </SourcesContent>
          ))}
          {pluginSearchSources.map((source) => (
            <SourcesContent key={`${message.id}-search-${source.url}`}>
              {/* Already URL-or-title resolved by `webSearchSources`, which
              falls back the same way the native pills above do. */}
              <Source href={source.url} title={source.title} />
            </SourcesContent>
          ))}
        </Sources>
      )}
      {message.parts?.map((part, i) => {
        if (part.type === "text") {
          if (isEditing) {
            const isFirstTextPart =
              i === message.parts.findIndex((p) => p.type === "text");
            if (!isFirstTextPart) return null;

            return (
              <Message
                key={`${message.id}-${i}`}
                from={message.role}
                avatar={assistantAvatar}
              >
                <MessageContent className="max-w-full">
                  <Textarea
                    ref={editTextareaRef}
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    className="min-h-[100px]"
                    autoFocus
                  />
                </MessageContent>
              </Message>
            );
          }

          return (
            <Message
              key={`${message.id}-${i}`}
              from={message.role}
              avatar={assistantAvatar}
            >
              <MessageContent className="max-w-full">
                <MessageResponse>{(part as TextUIPart).text}</MessageResponse>
              </MessageContent>
            </Message>
          );
        } else if (part.type === "reasoning") {
          return (
            <Reasoning
              key={`${message.id}-${i}`}
              isStreaming={
                status === "streaming" &&
                i === message.parts.length - 1 &&
                isLastMessage
              }
              defaultOpen={false}
            >
              <ReasoningTrigger className="cursor-pointer" />
              <ReasoningContent>{part.text}</ReasoningContent>
            </Reasoning>
          );
        } else if (part.type === "dynamic-tool") {
          const toolPart = part as DynamicToolUIPart;
          return (
            <Tool key={`${message.id}-${i}`}>
              <DynamicToolHeader
                state={toolPart.state}
                title={toolPart.toolName}
                durationMs={toolCallDurationMs(
                  toolPart.toolMetadata,
                  message.metadata,
                  toolPart.toolCallId,
                )}
              />
              <ToolContent>
                <ToolInput input={toolPart.input} />
                <ToolOutput
                  output={toolPart.output}
                  errorText={toolPart.errorText}
                />
              </ToolContent>
            </Tool>
          );
        } else if (part.type === "tool-loadSkill") {
          return <LoadSkillTool key={`${message.id}-${i}`} toolPart={part} />;
        } else if (isToolUIPart(part) && isPluginWebSearchPart(part)) {
          // Before the generic branch: its results are already the Sources row
          // above, so the raw JSON body would repeat every one of them.
          //
          // The predicate is shared with the Sources lifting and excludes
          // provider-executed calls: native search registers under the same
          // `web_search` name, and its parts belong on the generic renderer, which
          // shows the vendor payload this card cannot read.
          return <WebSearchTool key={`${message.id}-${i}`} toolPart={part} />;
        } else if (
          isToolUIPart(part) &&
          part.type.startsWith("tool-delegateTo")
        ) {
          // Sub-agent tools get custom UI with robot icon and nested chat
          return (
            <SubAgentTool
              key={`${message.id}-${i}`}
              toolPart={part}
              messageMetadata={message.metadata}
            />
          );
        } else if (isToolUIPart(part)) {
          // Plugin- and MCP-contributed tools aren't enumerated in the part
          // union (see `CustomUITools`), so they land on the generic renderer.
          const toolInput = part.input as Record<string, unknown> | undefined;
          const toolLabel = (toolInput?.label ?? toolInput?.name) as
            string | undefined;
          return (
            <Tool key={`${message.id}-${i}`}>
              <ToolHeader
                state={part.state}
                type={part.type}
                label={toolLabel}
                durationMs={toolCallDurationMs(
                  part.toolMetadata,
                  message.metadata,
                  part.toolCallId,
                )}
              />
              <ToolContent>
                <ToolInput input={part.input} />
                <ToolOutput output={part.output} errorText={part.errorText} />
              </ToolContent>
            </Tool>
          );
        } else if (
          part.type === "file" &&
          (part as FileUIPart).mediaType?.startsWith("image/")
        ) {
          const filePart = part as FileUIPart;
          return (
            <Message
              key={`${message.id}-${i}`}
              from={message.role}
              avatar={assistantAvatar}
            >
              <MessageContent className="max-w-full">
                {/* Generated/uploaded image served from a backend or data: URL;
                not routable through the Next image optimizer. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={filePart.url}
                  alt={filePart.filename || "Generated image"}
                  className="max-w-full rounded-lg border"
                />
              </MessageContent>
            </Message>
          );
        } else {
          return null;
        }
      })}
      {message.role === "assistant" &&
        message.metadata?.truncatedByTokenLimit && (
          <CutShortNotice className="pl-8">{CUT_SHORT_NOTICE}</CutShortNotice>
        )}
      {!(isLastMessage && status === "streaming") &&
        (isEditing ? (
          <MessageActions className="justify-end">
            <MessageAction
              className="cursor-pointer text-muted-foreground"
              onClick={onEditSubmit}
              variant="ghost"
              size="icon"
              label="Save"
            >
              <CheckIcon className="size-4" />
            </MessageAction>
            <MessageAction
              className="cursor-pointer text-muted-foreground"
              onClick={onEditCancel}
              variant="ghost"
              size="icon"
              label="Cancel"
            >
              <XIcon className="size-4" />
            </MessageAction>
          </MessageActions>
        ) : (
          <MessageActions
            className={message.role === "user" ? "justify-end" : "pl-8"}
          >
            {message.role === "user" && (
              <MessageAction
                className="cursor-pointer text-muted-foreground"
                onClick={() => onEditStart(message.id, textContent)}
                variant="ghost"
                size="icon"
                label="Edit"
              >
                <PencilIcon className="size-4" />
              </MessageAction>
            )}
            <MessageAction
              className="cursor-pointer text-muted-foreground"
              onClick={() => onCopyMessage(textContent, message.id)}
              variant={copiedMessageId === message.id ? "secondary" : "ghost"}
              size="icon"
              label="Copy"
            >
              <CopyIcon className="size-4" />
            </MessageAction>
            <MessageAction
              className="cursor-pointer text-muted-foreground"
              onClick={() => onMessageDelete(message.id)}
              variant="ghost"
              size="icon"
              label="Delete"
            >
              <TrashIcon className="size-4" />
            </MessageAction>
            {message.role === "assistant" && isLastMessage && (
              <MessageAction
                className="cursor-pointer text-muted-foreground"
                onClick={onRegenerate}
                variant="ghost"
                size="icon"
                label="Regenerate"
              >
                <RefreshCwIcon className="size-4" />
              </MessageAction>
            )}
          </MessageActions>
        ))}
    </Fragment>
  );
});
