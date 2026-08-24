import { Fragment, memo, type ReactNode } from "react";
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
  ToolUIPart,
  isToolUIPart,
  type ChatStatus,
} from "ai";
import { Agent, isPresentableUrl } from "@platypus/schemas";
import { isImageAttachment } from "@/lib/message-parts";
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
import { ResponseMetricsPopover } from "./response-metrics-popover";
import { TurnNotice } from "./turn-notice";
import { LoadSkillTool } from "./load-skill-tool";
import { SubAgentTool } from "./sub-agent-tool";
import {
  WebToolCard,
  isNormalizedWebToolPart,
  webSearchSources,
} from "./web-search-tool";

/**
 * What the person reading a reply is told when it stopped at the model's
 * output ceiling rather than because the model was finished. A constant so
 * tests assert the wording without restating the prose.
 */
export const CUT_SHORT_NOTICE =
  "Response cut short at the model's output limit.";

/**
 * The same thing for the other limit: the turn's tool-calling loop ran out of
 * steps while the model was still working, so the reply is whatever it had
 * produced by then — often nothing after the last tool card. States the fact and
 * stops: the ceiling is raisable on an Agent turn and not on a direct one, so a
 * remedy sentence would be wrong for half the turns that see this.
 */
export const STEP_LIMIT_NOTICE = "Response cut short at the step limit.";

/**
 * What the person reading a reply is told when they turned search on and the
 * turn served none — the backend the Provider names is gone, or it failed to
 * start. The model was never told, so the reply reads as if it simply had
 * nothing to look up; this is the only place that difference is visible.
 */
export const SEARCH_UNAVAILABLE_NOTICE =
  "Search was unavailable — this reply was written without it.";

type MessagePart = NonNullable<PlatypusUIMessage["parts"]>[number];

const isLoadSkillPart = (part: MessagePart) => part.type === "tool-loadSkill";

const isSubAgentToolPart = (part: MessagePart) =>
  isToolUIPart(part) && part.type.startsWith("tool-delegateTo");

const isWebToolPart = (part: MessagePart) =>
  isToolUIPart(part) && isNormalizedWebToolPart(part);

/**
 * Every tool-shaped part that has its own specialised renderer below. Kept as
 * one list so the generic renderer's exclusion (`isGenericToolPart`) can be
 * built from it directly, rather than restated by hand — a part can render
 * through at most one of a specialised card or the generic renderer no
 * matter what order `partRenderers` lists them in, because the generic
 * predicate itself can never be true for a part one of these already claims.
 * Adding a renderer for a new tool-shaped part means adding its predicate
 * here; nothing about where it sits in `partRenderers` matters.
 */
const specializedToolMatchers: Array<(part: MessagePart) => boolean> = [
  isLoadSkillPart,
  isWebToolPart,
  isSubAgentToolPart,
];

/**
 * Plugin- and MCP-contributed tools aren't enumerated in the part union (see
 * `CustomUITools`), so they land here by elimination — anything tool-shaped
 * that no specialised renderer above has already claimed.
 *
 * Exported so a test can assert the exclusion directly: a Web tool block part
 * or Sub-Agent part must never also satisfy this, or its raw JSON body would
 * repeat what the specialised card (and, for search, the Sources row above
 * the parts loop) already shows.
 */
export const isGenericToolPart = (part: MessagePart) =>
  isToolUIPart(part) &&
  !specializedToolMatchers.some((matches) => matches(part));

const isImageFilePart = (part: MessagePart) =>
  part.type === "file" && isImageAttachment(part as FileUIPart);

interface PartRenderer {
  matches: (part: MessagePart) => boolean;
  render: (part: MessagePart, i: number) => ReactNode;
}

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
  /**
   * `toolCallId`s whose result Tool-result clearing (ADR-0018 Notes, issue
   * #524) would leave out of the NEXT model call — derived per render from
   * the current Context occupancy reading, never persisted. Absent/empty
   * renders every tool part exactly as before.
   */
  staleToolCallIds?: ReadonlySet<string>;
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
  staleToolCallIds,
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
      part.type === "file" && !isImageFilePart(part),
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

  // Each entry's `matches` is mutually exclusive with every other entry's by
  // construction (see `isGenericToolPart`), so this list can be extended or
  // reordered freely — the first (and only) match wins regardless of
  // position.
  const partRenderers: PartRenderer[] = [
    {
      matches: (part) => part.type === "text",
      render: (part, i) => {
        const textPart = part as TextUIPart;
        if (isEditing) {
          const isFirstTextPart =
            i === (message.parts ?? []).findIndex((p) => p.type === "text");
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
              <MessageResponse>{textPart.text}</MessageResponse>
            </MessageContent>
          </Message>
        );
      },
    },
    {
      matches: (part) => part.type === "reasoning",
      render: (part, i) => {
        const reasoningPart = part as Extract<
          MessagePart,
          { type: "reasoning" }
        >;
        return (
          <Reasoning
            key={`${message.id}-${i}`}
            isStreaming={
              status === "streaming" &&
              i === (message.parts?.length ?? 0) - 1 &&
              isLastMessage
            }
            defaultOpen={false}
          >
            <ReasoningTrigger className="cursor-pointer" />
            <ReasoningContent>{reasoningPart.text}</ReasoningContent>
          </Reasoning>
        );
      },
    },
    {
      matches: (part) => part.type === "dynamic-tool",
      render: (part, i) => {
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
      },
    },
    {
      matches: isLoadSkillPart,
      render: (part, i) => (
        <LoadSkillTool
          key={`${message.id}-${i}`}
          toolPart={part as Extract<MessagePart, { type: "tool-loadSkill" }>}
        />
      ),
    },
    {
      matches: isWebToolPart,
      render: (part, i) => (
        <WebToolCard
          key={`${message.id}-${i}`}
          toolPart={part as ToolUIPart}
          messageMetadata={message.metadata}
          cleared={staleToolCallIds?.has((part as ToolUIPart).toolCallId)}
        />
      ),
    },
    {
      matches: isSubAgentToolPart,
      render: (part, i) => (
        <SubAgentTool
          key={`${message.id}-${i}`}
          toolPart={part as ToolUIPart}
          messageMetadata={message.metadata}
        />
      ),
    },
    {
      matches: isGenericToolPart,
      render: (part, i) => {
        const toolPart = part as ToolUIPart;
        const toolInput = toolPart.input as Record<string, unknown> | undefined;
        const toolLabel = (toolInput?.label ?? toolInput?.name) as
          string | undefined;
        return (
          <Tool key={`${message.id}-${i}`}>
            <ToolHeader
              state={toolPart.state}
              type={toolPart.type}
              label={toolLabel}
              durationMs={toolCallDurationMs(
                toolPart.toolMetadata,
                message.metadata,
                toolPart.toolCallId,
              )}
              cleared={staleToolCallIds?.has(toolPart.toolCallId)}
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
      },
    },
    {
      matches: isImageFilePart,
      render: (part, i) => {
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
      },
    },
  ];

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
        const renderer = partRenderers.find((r) => r.matches(part));
        return renderer ? renderer.render(part, i) : null;
      })}
      {/* How the reply was produced, then how it ended — both rows render when
      both apply, in that order. */}
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
            {message.role === "assistant" && (
              // Leftmost, before Copy, and deliberately not adjacent to
              // Delete — a frequently-poked new control beside an
              // undoable action invites mis-clicks (issue #354).
              <ResponseMetricsPopover metadata={message.metadata} />
            )}
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
