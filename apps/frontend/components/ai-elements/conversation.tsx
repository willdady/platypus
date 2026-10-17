"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ArrowDownIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { useCallback } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";

export type ConversationProps = ComponentProps<typeof StickToBottom>;

export function Conversation({ className, ...props }: ConversationProps) {
  return (
    <StickToBottom
      className={cn("relative flex-1 overflow-y-auto", className)}
      initial="smooth"
      resize="smooth"
      role="log"
      {...props}
    />
  );
}

export type ConversationContentProps = ComponentProps<
  typeof StickToBottom.Content
>;

export function ConversationContent({
  className,
  ...props
}: ConversationContentProps) {
  return <StickToBottom.Content className={cn("p-4", className)} {...props} />;
}

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

export function ConversationScrollButton({
  className,
  ...props
}: ConversationScrollButtonProps) {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  const handleScrollToBottom = useCallback(() => {
    void scrollToBottom();
  }, [scrollToBottom]);

  return (
    !isAtBottom && (
      <Button
        className={cn(
          "absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full",
          className,
        )}
        onClick={handleScrollToBottom}
        size="icon"
        aria-label="Scroll to bottom"
        type="button"
        variant="outline"
        {...props}
      >
        <ArrowDownIcon />
      </Button>
    )
  );
}
