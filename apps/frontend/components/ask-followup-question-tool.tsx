import {
  type PlatypusUIMessage,
  type PlatypusTools,
} from "@platypus/backend/src/types";
import {
  Message,
  MessageContent,
  MessageResponse,
  MessageAction,
} from "./ai-elements/message";
import { type ToolUIPart } from "ai";
import { ClipboardPasteIcon, Loader2Icon } from "lucide-react";
import { Item, ItemContent, ItemGroup, ItemTitle } from "./ui/item";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

export interface AskFollowupQuestionToolProps {
  toolPart: ToolUIPart;
  onAppendToPrompt?: (text: string) => void;
  onSubmitMessage?: (text: string) => void;
  messageId: string;
  role: PlatypusUIMessage["role"];
  index: number;
}

export const AskFollowupQuestionTool = ({
  toolPart,
  onAppendToPrompt,
  onSubmitMessage,
  messageId,
  role,
  index,
}: AskFollowupQuestionToolProps) => {
  const input = toolPart.input as PlatypusTools["askFollowupQuestion"]["input"];

  if (toolPart.state === "output-error") {
    return (
      <Message key={`${messageId}-${index}`} from={role}>
        <MessageContent className="max-w-full">
          <div className="text-destructive text-sm">
            Error:{" "}
            {toolPart.errorText ||
              "An error occurred while asking the follow-up question."}
          </div>
        </MessageContent>
      </Message>
    );
  }

  const isStreaming = toolPart.state === "input-streaming";

  if (!input?.question && isStreaming) {
    return (
      <Message key={`${messageId}-${index}`} from={role}>
        <MessageContent className="max-w-full">
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Loader2Icon className="size-4 animate-spin" />
            <span>Thinking...</span>
          </div>
        </MessageContent>
      </Message>
    );
  }

  if (!input?.question) return null;

  return (
    <Message key={`${messageId}-${index}`} from={role}>
      <MessageContent className="max-w-full">
        <div className="flex flex-col gap-3">
          <MessageResponse>{input.question}</MessageResponse>
          {input.followUp && input.followUp.length > 0 && (
            <ItemGroup className="gap-2">
              {input.followUp.map((text, idx) => (
                <Item
                  key={idx}
                  variant="outline"
                  size="sm"
                  className="cursor-pointer"
                  onClick={() => onSubmitMessage?.(text)}
                >
                  <ItemContent>
                    <ItemTitle>{text}</ItemTitle>
                  </ItemContent>
                  <Tooltip delayDuration={700}>
                    <TooltipTrigger asChild>
                      <MessageAction
                        variant="ghost"
                        size="icon"
                        label="Paste to prompt"
                        className="cursor-pointer size-7 text-muted-foreground"
                        onClick={(e) => {
                          e.stopPropagation();
                          onAppendToPrompt?.(text);
                        }}
                      >
                        <ClipboardPasteIcon className="size-3.5" />
                      </MessageAction>
                    </TooltipTrigger>
                    <TooltipContent side="top">Paste to prompt</TooltipContent>
                  </Tooltip>
                </Item>
              ))}
            </ItemGroup>
          )}
        </div>
      </MessageContent>
    </Message>
  );
};
