"use client";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { linkSafety } from "@/components/link-safety";
import { isImageAttachment } from "@/lib/message-parts";
import { useStreamdownControls } from "@/hooks/use-streamdown-controls";
import { cn } from "@/lib/utils";
import type { FileUIPart, UIMessage } from "ai";
import { PaperclipIcon, XIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes, ReactNode } from "react";
import { memo } from "react";
import { Streamdown } from "streamdown";
import { lazyCode, lazyMermaid } from "./lazy-streamdown-plugins";

// Module-level, so the memoised response keeps one plugins object.
const plugins = { code: lazyCode, mermaid: lazyMermaid };

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"];
  avatar?: ReactNode;
};

export function Message({
  className,
  from,
  avatar,
  children,
  ...props
}: MessageProps) {
  return (
    <div
      className={cn(
        // Wider on a phone, where 80% of a narrow column costs more than the
        // gutter it buys back.
        "group flex w-full max-w-[85%] gap-2 sm:max-w-[80%]",
        from === "user" ? "is-user ml-auto justify-end" : "is-assistant",
        className,
      )}
      {...props}
    >
      {from === "assistant" && avatar && (
        <div className="mt-0.5 flex-shrink-0">{avatar}</div>
      )}
      <div className="flex min-w-0 flex-col gap-2">{children}</div>
    </div>
  );
}

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export function MessageContent({
  children,
  className,
  ...props
}: MessageContentProps) {
  return (
    <div
      className={cn(
        "is-user:dark flex w-fit flex-col gap-2 overflow-hidden text-sm",
        "group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground",
        "group-[.is-assistant]:text-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export type MessageActionsProps = ComponentProps<"div">;

export function MessageActions({
  className,
  children,
  ...props
}: MessageActionsProps) {
  return (
    <div className={cn("flex items-center gap-1", className)} {...props}>
      {children}
    </div>
  );
}

export type MessageActionProps = ComponentProps<typeof Button> & {
  tooltip?: string;
  label?: string;
};

export function MessageAction({
  tooltip,
  children,
  label,
  variant = "ghost",
  size = "icon-sm",
  ...props
}: MessageActionProps) {
  const button = (
    <Button size={size} type="button" variant={variant} {...props}>
      {children}
      <span className="sr-only">{label || tooltip}</span>
    </Button>
  );

  // `Tooltip` brings its own provider; a second one around it is redundant.
  if (tooltip) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent>
          <p>{tooltip}</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  return button;
}

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => {
    const controls = useStreamdownControls();
    return (
      <Streamdown
        linkSafety={linkSafety}
        controls={controls}
        plugins={plugins}
        {...props}
        className={cn(
          "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
          className,
        )}
      />
    );
  },
  (prevProps, nextProps) => prevProps.children === nextProps.children,
);

MessageResponse.displayName = "MessageResponse";

export type MessageAttachmentProps = HTMLAttributes<HTMLDivElement> & {
  data: FileUIPart;
  className?: string;
  onRemove?: () => void;
};

export function MessageAttachment({
  data,
  className,
  onRemove,
  ...props
}: MessageAttachmentProps) {
  const filename = data.filename || "";
  const isImage = isImageAttachment(data);
  const attachmentLabel = filename || (isImage ? "Image" : "Attachment");

  return (
    <div
      className={cn(
        "group relative size-24 overflow-hidden rounded-lg",
        className,
      )}
      {...props}
    >
      {isImage ? (
        <>
          {/* Attachment served from a blob:/data:/backend URL; not routable
          through the Next image optimizer. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            alt={filename || "attachment"}
            className="size-full object-cover"
            decoding="async"
            height={100}
            loading="lazy"
            src={data.url}
            width={100}
          />
          {onRemove && (
            <Button
              aria-label="Remove attachment"
              className="absolute top-2 right-2 size-6 rounded-full bg-background/80 p-0 opacity-0 backdrop-blur-sm transition-opacity hover:bg-background group-hover:opacity-100 [&>svg]:size-3"
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
              type="button"
              variant="ghost"
            >
              <XIcon />
              <span className="sr-only">Remove</span>
            </Button>
          )}
        </>
      ) : (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex size-full shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <PaperclipIcon className="size-4" />
              </div>
            </TooltipTrigger>
            <TooltipContent>
              <p>{attachmentLabel}</p>
            </TooltipContent>
          </Tooltip>
          {onRemove && (
            <Button
              aria-label="Remove attachment"
              className="size-6 shrink-0 rounded-full p-0 opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100 [&>svg]:size-3"
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
              type="button"
              variant="ghost"
            >
              <XIcon />
              <span className="sr-only">Remove</span>
            </Button>
          )}
        </>
      )}
    </div>
  );
}

export type MessageAttachmentsProps = ComponentProps<"div">;

export function MessageAttachments({
  children,
  className,
  ...props
}: MessageAttachmentsProps) {
  if (!children) {
    return null;
  }

  return (
    <div
      className={cn(
        "ml-auto flex w-fit flex-wrap items-start gap-2",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
