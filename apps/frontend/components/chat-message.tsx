import { Fragment } from "react";
import { UIMessage } from "ai";
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
import { DynamicToolUIPart, ToolUIPart, FileUIPart, TextUIPart } from "ai";
import {
  CheckIcon,
  PencilIcon,
  CopyIcon,
  TrashIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import { Textarea } from "./ui/textarea";

interface ChatMessageProps {
  /** The message object to render */
  message: UIMessage;
  /** Whether this is the last message in the conversation */
  isLastMessage: boolean;
  /** Current chat status (e.g., "streaming", "idle") */
  status: string;
  /** Whether this message is currently being edited */
  isEditing: boolean;
  /** Current content of the message being edited */
  editContent: string;
  /** Ref to the textarea element for editing */
  editTextareaRef: React.RefObject<HTMLTextAreaElement | null>;
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

export const ChatMessage = ({
  message,
  isLastMessage,
  status,
  isEditing,
  editContent,
  editTextareaRef,
  setEditContent,
  onEditStart,
  onEditCancel,
  onEditSubmit,
  onMessageDelete,
  onRegenerate,
  onCopyMessage,
  copiedMessageId,
}: ChatMessageProps) => {
  const fileParts = message.parts?.filter(
    (part): part is FileUIPart =>
      part.type === "file" && !part.mediaType?.startsWith("image/"),
  );
  const sourceUrlParts = message.parts?.filter(
    (part) => part.type === "source-url",
  );

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
      {message.role === "assistant" && !!sourceUrlParts?.length && (
        <Sources>
          <SourcesTrigger count={sourceUrlParts.length} />
          {sourceUrlParts.map((part, i) => (
            <SourcesContent key={`${message.id}-${i}`}>
              <Source href={part.url} title={part.url} />
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
              <Message key={`${message.id}-${i}`} from={message.role}>
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
            <Message key={`${message.id}-${i}`} from={message.role}>
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
        } else if (part.type.startsWith("tool-")) {
          const toolPart = part as ToolUIPart;
          return (
            <Tool key={`${message.id}-${i}`}>
              <ToolHeader state={toolPart.state} type={toolPart.type} />
              <ToolContent>
                <ToolInput input={toolPart.input} />
                <ToolOutput
                  output={toolPart.output}
                  errorText={toolPart.errorText}
                />
              </ToolContent>
            </Tool>
          );
        } else if (
          part.type === "file" &&
          (part as FileUIPart).mediaType?.startsWith("image/")
        ) {
          const filePart = part as FileUIPart;
          return (
            <Message key={`${message.id}-${i}`} from={message.role}>
              <MessageContent className="max-w-full">
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
      {isEditing ? (
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
          className={message.role === "user" ? "justify-end" : ""}
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
      )}
    </Fragment>
  );
};
