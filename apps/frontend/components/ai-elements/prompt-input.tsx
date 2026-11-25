"use client";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  useSpeechToText,
  type SpeechToTextFaultCode,
} from "@/hooks/use-speech-to-text";
import { isImageAttachment } from "@/lib/message-parts";
import { cn } from "@/lib/utils";
import { SANDBOX_TRANSFER_MAX_BYTES, formatFileSize } from "@platypus/schemas";
import type { ChatStatus, FileUIPart } from "ai";
import {
  BoxIcon,
  CornerDownLeftIcon,
  FileIcon,
  ImageIcon,
  Loader2Icon,
  MicIcon,
  PaperclipIcon,
  PlusIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { nanoid } from "nanoid";
import { toast } from "sonner";
import {
  Children,
  type ClipboardEventHandler,
  type ComponentProps,
  createContext,
  type FormEvent,
  type FormEventHandler,
  Fragment,
  type HTMLAttributes,
  type KeyboardEventHandler,
  type ReactNode,
  type RefObject,
  type ChangeEventHandler,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export type SandboxFile = { id: string; file: File };

type AttachmentChip =
  | { kind: "file"; file: FileUIPart & { id: string } }
  | { kind: "sandbox"; file: SandboxFile };

type AttachmentsContext = {
  files: (FileUIPart & { id: string })[];
  sandboxFiles: SandboxFile[];
  chips: AttachmentChip[];
  add: (files: File[] | FileList) => void;
  remove: (id: string) => void;
  clear: () => void;
  openFileDialog: () => void;
  openSandboxFileDialog: () => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
};

const PromptInputAttachmentsContext = createContext<AttachmentsContext | null>(
  null,
);

export function usePromptInputAttachments() {
  const context = useContext(PromptInputAttachmentsContext);
  if (!context) {
    throw new Error(
      "usePromptInputAttachments must be used within a PromptInput",
    );
  }
  return context;
}

function fileMatchesAccept(file: File, accept: string): boolean {
  const patterns = accept
    .split(",")
    .map((pattern) => pattern.trim())
    .filter(Boolean);

  if (patterns.length === 0) {
    return true;
  }

  return patterns.some((pattern) => {
    if (pattern.startsWith(".")) {
      return file.name.toLowerCase().endsWith(pattern.toLowerCase());
    }
    if (pattern.endsWith("/*")) {
      return file.type.startsWith(pattern.slice(0, -1));
    }
    return file.type === pattern;
  });
}

export type PromptInputAttachmentProps = HTMLAttributes<HTMLDivElement> & {
  data: FileUIPart & { id: string };
  className?: string;
};

export function PromptInputAttachment({
  data,
  className,
  ...props
}: PromptInputAttachmentProps) {
  const attachments = usePromptInputAttachments();

  const filename = data.filename || "";

  const isImage = isImageAttachment(data);

  const attachmentLabel = filename || (isImage ? "Image" : "Attachment");

  return (
    <HoverCard closeDelay={0} openDelay={0}>
      <HoverCardTrigger asChild>
        <div
          className={cn(
            "group relative flex h-8 cursor-default select-none items-center gap-1.5 rounded-md border border-border px-1.5 font-medium text-sm transition-all hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
            className,
          )}
          key={data.id}
          {...props}
        >
          <div className="relative size-5 shrink-0">
            <div className="absolute inset-0 flex size-5 items-center justify-center overflow-hidden rounded bg-background transition-opacity group-hover:opacity-0">
              {isImage ? (
                // why: a blob:/data:/backend URL cannot go through the Next image optimizer
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  alt={filename || "attachment"}
                  className="size-5 object-cover"
                  decoding="async"
                  height={20}
                  src={data.url}
                  width={20}
                />
              ) : (
                <div className="flex size-5 items-center justify-center text-muted-foreground">
                  <PaperclipIcon className="size-3" />
                </div>
              )}
            </div>
            <Button
              aria-label="Remove attachment"
              className="absolute inset-0 size-5 rounded p-0 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 [&>svg]:size-2.5"
              onClick={(e) => {
                e.stopPropagation();
                attachments.remove(data.id);
              }}
              type="button"
              variant="ghost"
            >
              <XIcon />
              <span className="sr-only">Remove</span>
            </Button>
          </div>

          <span className="flex-1 truncate">{attachmentLabel}</span>
        </div>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-auto p-2">
        <div className="w-auto flex flex-col gap-3">
          {isImage && (
            <div className="flex max-h-96 w-96 items-center justify-center overflow-hidden rounded-md border">
              {
                // why: a blob:/data:/backend URL cannot go through the Next image optimizer
              }
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                alt={filename || "attachment preview"}
                className="max-h-full max-w-full object-contain"
                decoding="async"
                height={384}
                src={data.url}
                width={448}
              />
            </div>
          )}
          <div className="flex items-center gap-2.5">
            <div className="min-w-0 flex-1 flex flex-col gap-1 px-0.5">
              <h4 className="truncate font-semibold text-sm leading-none">
                {filename || (isImage ? "Image" : "Attachment")}
              </h4>
              {data.mediaType && (
                <p className="truncate font-mono text-muted-foreground text-xs">
                  {data.mediaType}
                </p>
              )}
            </div>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

export function PromptInputSandboxUpload({ data }: { data: SandboxFile }) {
  const attachments = usePromptInputAttachments();

  return (
    <div
      className="group relative flex h-8 cursor-default select-none items-center gap-1.5 rounded-md border border-border px-1.5 font-medium text-sm"
      title={`${data.file.name} (${formatFileSize(data.file.size)})`}
    >
      <div className="relative size-5 shrink-0">
        <div className="absolute inset-0 flex size-5 items-center justify-center text-muted-foreground transition-opacity group-hover:opacity-0">
          <FileIcon className="size-3" />
        </div>
        <Button
          aria-label="Remove Sandbox upload"
          className="absolute inset-0 size-5 rounded p-0 opacity-0 transition-opacity group-hover:opacity-100 [&>svg]:size-2.5"
          onClick={(e) => {
            e.stopPropagation();
            attachments.remove(data.id);
          }}
          type="button"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </div>
      <span className="truncate">{data.file.name}</span>
      <span className="rounded bg-muted px-1 text-muted-foreground text-xs">
        Sandbox
      </span>
    </div>
  );
}

export type PromptInputAttachmentsProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  "children"
> & {
  children: (attachment: FileUIPart & { id: string }) => ReactNode;
};

export function PromptInputAttachments({
  children,
  className,
  ...props
}: PromptInputAttachmentsProps) {
  const attachments = usePromptInputAttachments();

  if (!attachments.chips.length) {
    return null;
  }

  return (
    <div
      className={cn("flex flex-wrap items-center gap-2 p-3", className)}
      {...props}
    >
      {attachments.chips.map((chip) =>
        chip.kind === "file" ? (
          <Fragment key={chip.file.id}>{children(chip.file)}</Fragment>
        ) : (
          <PromptInputSandboxUpload data={chip.file} key={chip.file.id} />
        ),
      )}
    </div>
  );
}

export type PromptInputActionAddAttachmentsProps = ComponentProps<
  typeof DropdownMenuItem
> & {
  label?: string;
};

export function PromptInputActionAddAttachments({
  label = "Add photos or files",
  ...props
}: PromptInputActionAddAttachmentsProps) {
  const attachments = usePromptInputAttachments();

  return (
    <DropdownMenuItem
      {...props}
      onSelect={(e) => {
        e.preventDefault();
        attachments.openFileDialog();
      }}
    >
      <ImageIcon className="size-4" />
      {label}
    </DropdownMenuItem>
  );
}

export function PromptInputActionAddSandboxUploads(
  props: ComponentProps<typeof DropdownMenuItem>,
) {
  const attachments = usePromptInputAttachments();

  return (
    <DropdownMenuItem
      {...props}
      onSelect={(e) => {
        e.preventDefault();
        attachments.openSandboxFileDialog();
      }}
    >
      <BoxIcon className="size-4" />
      Upload to Sandbox
    </DropdownMenuItem>
  );
}

export type PromptInputMessage = {
  text: string;
  files: FileUIPart[];
  sandboxFiles?: File[];
};

export type PromptInputError = {
  code: "accept" | "conversion" | "submit";
  message: string;
};

export type PromptInputProps = Omit<
  HTMLAttributes<HTMLFormElement>,
  "onSubmit" | "onError"
> & {
  accept?: string;
  initialAttachments?: FileUIPart[];
  globalDrop?: boolean;
  onError?: (err: PromptInputError) => void;
  onSubmit: (
    message: PromptInputMessage,
    event: FormEvent<HTMLFormElement>,
  ) => void | Promise<void>;
};

export function PromptInput({
  className,
  accept,
  initialAttachments,
  globalDrop,
  onError,
  onSubmit,
  children,
  ...props
}: PromptInputProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const sandboxInputRef = useRef<HTMLInputElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  const [files, setItems] = useState<(FileUIPart & { id: string })[]>(() =>
    (initialAttachments ?? []).map((part) => ({ ...part, id: nanoid() })),
  );

  const [sandboxFiles, setSandboxFiles] = useState<SandboxFile[]>([]);

  const openFileDialog = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const openSandboxFileDialog = useCallback(() => {
    sandboxInputRef.current?.click();
  }, []);

  const addSandbox = useCallback((fileList: File[] | FileList) => {
    // why: refused on pick — the transfer bound is fixed, so it could never be sent
    const accepted = Array.from(fileList).filter((f) => {
      if (f.size <= SANDBOX_TRANSFER_MAX_BYTES) return true;
      toast.error(
        `${f.name} is larger than ${SANDBOX_TRANSFER_MAX_BYTES / 1024 / 1024} MiB, the Sandbox upload limit.`,
      );
      return false;
    });
    setSandboxFiles((prev) =>
      prev.concat(accepted.map((file) => ({ id: nanoid(), file }))),
    );
  }, []);

  const matchesAccept = useCallback(
    (f: File) => {
      if (!accept || accept.trim() === "") {
        return true;
      }
      return fileMatchesAccept(f, accept);
    },
    [accept],
  );

  const add = useCallback(
    (fileList: File[] | FileList) => {
      const incoming = Array.from(fileList);
      const accepted = incoming.filter((f) => matchesAccept(f));
      if (incoming.length && accepted.length === 0) {
        onError?.({
          code: "accept",
          message: "No files match the accepted types.",
        });
        return;
      }

      setItems((prev) => {
        const next: (FileUIPart & { id: string })[] = [];
        for (const file of accepted) {
          next.push({
            id: nanoid(),
            type: "file",
            url: URL.createObjectURL(file),
            mediaType: file.type,
            filename: file.name,
          });
        }
        return prev.concat(next);
      });
    },
    [matchesAccept, onError],
  );

  const remove = useCallback((id: string) => {
    setSandboxFiles((prev) => prev.filter((file) => file.id !== id));
    setItems((prev) => {
      const found = prev.find((file) => file.id === id);
      if (found?.url) {
        URL.revokeObjectURL(found.url);
      }
      return prev.filter((file) => file.id !== id);
    });
  }, []);

  const clear = useCallback(() => {
    setSandboxFiles([]);
    setItems((prev) => {
      for (const file of prev) {
        if (file.url) {
          URL.revokeObjectURL(file.url);
        }
      }
      return [];
    });
  }, []);

  useEffect(() => {
    const form = formRef.current;
    if (!form) return;

    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) {
        e.preventDefault();
      }
    };
    const onDrop = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) {
        e.preventDefault();
      }
      e.stopPropagation();
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        add(e.dataTransfer.files);
      }
    };
    form.addEventListener("dragover", onDragOver);
    form.addEventListener("drop", onDrop);
    return () => {
      form.removeEventListener("dragover", onDragOver);
      form.removeEventListener("drop", onDrop);
    };
  }, [add]);

  useEffect(() => {
    if (!globalDrop) return;

    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) {
        e.preventDefault();
      }
    };
    const onDrop = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) {
        e.preventDefault();
      }
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        add(e.dataTransfer.files);
      }
    };
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", onDrop);
    };
  }, [add, globalDrop]);

  const liveFilesRef = useRef(files);
  useEffect(() => {
    liveFilesRef.current = files;
  }, [files]);

  useEffect(
    () => () => {
      for (const f of liveFilesRef.current) {
        if (f.url) URL.revokeObjectURL(f.url);
      }
    },
    [],
  );

  const handleChange: ChangeEventHandler<HTMLInputElement> = (event) => {
    if (event.currentTarget.files) {
      add(event.currentTarget.files);
    }
  };

  const convertBlobUrlToDataUrl = async (url: string): Promise<string> => {
    const response = await fetch(url);
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };

  const reportFailure = (code: PromptInputError["code"], message: string) => {
    const failure = { code, message };
    if (onError) {
      onError(failure);
    } else {
      toast.error(message);
    }
  };

  const reportConversionFailure = () => {
    reportFailure(
      "conversion",
      "Couldn't read an attachment. Remove it and try again.",
    );
  };

  const reportSendFailure = () => {
    reportFailure("submit", "Your message couldn't be sent. Try again.");
  };

  const ctx = useMemo<AttachmentsContext>(
    () => ({
      files: files.map((item) => ({ ...item, id: item.id })),
      sandboxFiles,
      chips: [
        ...files.map((file): AttachmentChip => ({ kind: "file", file })),
        ...sandboxFiles.map((file): AttachmentChip => ({
          kind: "sandbox",
          file,
        })),
      ],
      add,
      remove,
      clear,
      openFileDialog,
      openSandboxFileDialog,
      fileInputRef: inputRef,
    }),
    [
      files,
      sandboxFiles,
      add,
      remove,
      clear,
      openFileDialog,
      openSandboxFileDialog,
    ],
  );

  const handleSubmit: FormEventHandler<HTMLFormElement> = (event) => {
    event.preventDefault();

    const formData = new FormData(event.currentTarget);
    const text = (formData.get("message") as string) || "";

    // why: no reset() — each textarea is controlled and its owner clears it on success
    Promise.all(
      files.map(async ({ id, ...item }) => {
        if (item.url && item.url.startsWith("blob:")) {
          return {
            ...item,
            url: await convertBlobUrlToDataUrl(item.url),
          };
        }
        return item;
      }),
    ).then(
      (convertedFiles: FileUIPart[]) => {
        try {
          const result = onSubmit(
            {
              text,
              files: convertedFiles,
              sandboxFiles: sandboxFiles.map(({ file }) => file),
            },
            event,
          );

          if (result instanceof Promise) {
            // why: no clear() on failure so the user can retry the send
            result.then(clear, reportSendFailure);
          } else {
            clear();
          }
        } catch {
          // why: no clear() on failure so the user can retry the send
          reportSendFailure();
        }
      },
      // why: only the conversion rejection goes here; a failed send reports itself
      reportConversionFailure,
    );
  };

  return (
    <PromptInputAttachmentsContext.Provider value={ctx}>
      <input
        accept={accept}
        aria-label="Upload files"
        className="hidden"
        multiple
        onChange={handleChange}
        ref={inputRef}
        title="Upload files"
        type="file"
      />
      <input
        aria-label="Upload files to Sandbox"
        className="hidden"
        multiple
        onChange={(event) => {
          if (event.currentTarget.files) {
            addSandbox(event.currentTarget.files);
          }
          // why: reset so picking the same file again after removing its chip fires
          event.currentTarget.value = "";
        }}
        ref={sandboxInputRef}
        type="file"
      />
      <form
        className={cn("w-full", className)}
        onSubmit={handleSubmit}
        ref={formRef}
        {...props}
      >
        <InputGroup className="overflow-hidden">{children}</InputGroup>
      </form>
    </PromptInputAttachmentsContext.Provider>
  );
}

export type PromptInputBodyProps = HTMLAttributes<HTMLDivElement>;

export function PromptInputBody({ className, ...props }: PromptInputBodyProps) {
  return <div className={cn("contents", className)} {...props} />;
}

export type PromptInputTextareaProps = ComponentProps<
  typeof InputGroupTextarea
> & {
  status?: ChatStatus;
};

export function PromptInputTextarea({
  className,
  placeholder = "What would you like to know?",
  status,
  onKeyDown,
  ...props
}: PromptInputTextareaProps) {
  const attachments = usePromptInputAttachments();
  const [isComposing, setIsComposing] = useState(false);
  const isMobile = useIsMobile();

  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = (e) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) {
      return;
    }

    if (e.key === "Enter") {
      if (isComposing || e.nativeEvent.isComposing) {
        return;
      }
      if (isMobile) {
        // why: on a phone Enter always inserts a newline; the submit button sends
        return;
      }
      if (e.shiftKey) {
        return;
      }
      if (status === "streaming" || status === "submitted") {
        return;
      }
      e.preventDefault();

      const form = e.currentTarget.form;
      const submitButton = form?.querySelector(
        'button[type="submit"]',
      ) as HTMLButtonElement | null;
      if (submitButton?.disabled) {
        return;
      }

      form?.requestSubmit();
    }

    if (e.key === "Backspace" && e.currentTarget.value === "") {
      const lastChip = attachments.chips.at(-1);
      if (lastChip) {
        e.preventDefault();
        attachments.remove(lastChip.file.id);
      }
    }
  };

  const handlePaste: ClipboardEventHandler<HTMLTextAreaElement> = (event) => {
    const items = event.clipboardData?.items;

    if (!items) {
      return;
    }

    const files: File[] = [];

    for (const item of items) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) {
          files.push(file);
        }
      }
    }

    if (files.length > 0) {
      event.preventDefault();
      attachments.add(files);
    }
  };

  return (
    <InputGroupTextarea
      className={cn("field-sizing-content max-h-48 min-h-16", className)}
      name="message"
      onCompositionEnd={() => setIsComposing(false)}
      onCompositionStart={() => setIsComposing(true)}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      placeholder={placeholder}
      {...props}
    />
  );
}

export type PromptInputFooterProps = Omit<
  ComponentProps<typeof InputGroupAddon>,
  "align"
>;

export function PromptInputFooter({
  className,
  ...props
}: PromptInputFooterProps) {
  return (
    <InputGroupAddon
      align="block-end"
      className={cn("justify-between gap-1", className)}
      {...props}
    />
  );
}

export type PromptInputToolsProps = HTMLAttributes<HTMLDivElement>;

export function PromptInputTools({
  className,
  ...props
}: PromptInputToolsProps) {
  return (
    <div className={cn("flex items-center gap-1", className)} {...props} />
  );
}

export type PromptInputButtonProps = ComponentProps<typeof InputGroupButton>;

export function PromptInputButton({
  variant = "ghost",
  className,
  size,
  ...props
}: PromptInputButtonProps) {
  const newSize =
    size ?? (Children.count(props.children) > 1 ? "sm" : "icon-sm");

  return (
    <InputGroupButton
      className={cn(className)}
      size={newSize}
      type="button"
      variant={variant}
      {...props}
    />
  );
}

export type PromptInputActionMenuProps = ComponentProps<typeof DropdownMenu>;
export function PromptInputActionMenu(props: PromptInputActionMenuProps) {
  return <DropdownMenu {...props} />;
}

export type PromptInputActionMenuTriggerProps = PromptInputButtonProps;

export function PromptInputActionMenuTrigger({
  className,
  children,
  ...props
}: PromptInputActionMenuTriggerProps) {
  return (
    <DropdownMenuTrigger asChild>
      <PromptInputButton className={className} {...props}>
        {children ?? <PlusIcon className="size-4" />}
      </PromptInputButton>
    </DropdownMenuTrigger>
  );
}

export type PromptInputActionMenuContentProps = ComponentProps<
  typeof DropdownMenuContent
>;
export function PromptInputActionMenuContent({
  className,
  ...props
}: PromptInputActionMenuContentProps) {
  return (
    <DropdownMenuContent align="start" className={cn(className)} {...props} />
  );
}

export type PromptInputSubmitProps = ComponentProps<typeof InputGroupButton> & {
  status?: ChatStatus;
};

export function PromptInputSubmit({
  className,
  variant = "default",
  size = "icon-sm",
  status,
  children,
  ...props
}: PromptInputSubmitProps) {
  let Icon = <CornerDownLeftIcon className="size-4" />;

  if (status === "submitted") {
    Icon = <Loader2Icon className="size-4 animate-spin" />;
  } else if (status === "streaming") {
    Icon = <SquareIcon className="size-4" />;
  } else if (status === "error") {
    Icon = <XIcon className="size-4" />;
  }

  return (
    <InputGroupButton
      aria-label="Submit"
      className={cn(className)}
      size={size}
      type="submit"
      variant={variant}
      {...props}
    >
      {children ?? Icon}
    </InputGroupButton>
  );
}

export type PromptInputSpeechButtonProps = ComponentProps<
  typeof PromptInputButton
> & {
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  onTranscriptionChange?: (text: string) => void;
};

// why: permission denial and "not available" read differently — retrying only fixes one
const SPEECH_FAULT_MESSAGES: Record<SpeechToTextFaultCode, string> = {
  unsupported: "Voice input isn't supported in this browser.",
  "insecure-context":
    "Voice input needs a secure connection. Open this page over HTTPS or on localhost.",
  "not-allowed":
    "Microphone access is blocked. Allow the microphone for this site in your browser settings.",
  "service-not-allowed":
    "This device's speech service isn't available, so voice input can't run here.",
  network: "Voice input couldn't reach the speech service. Check your network.",
  "audio-capture": "No microphone was found.",
  "language-not-supported": "Voice input doesn't support this language.",
  "bad-grammar": "Voice input couldn't read its recognition grammar.",
  unknown: "Voice input stopped unexpectedly.",
};

export function PromptInputSpeechButton({
  className,
  textareaRef,
  onTranscriptionChange,
  onClick,
  ...props
}: PromptInputSpeechButtonProps) {
  const { isListening, fault, toggleListening } = useSpeechToText({
    textareaRef,
    onTranscriptionChange,
  });

  useEffect(() => {
    // why: fault is a fresh object per failure, so an identical retry still toasts
    if (fault) {
      toast.error(SPEECH_FAULT_MESSAGES[fault.code]);
    }
  }, [fault]);

  return (
    <PromptInputButton
      className={cn(
        "relative transition-all duration-200",
        isListening && "animate-pulse bg-accent text-accent-foreground",
        className,
      )}
      // why: stays enabled so its tooltip can explain; disabled takes no pointer events
      // why: onClick is composed, not spread — an asChild trigger would replace it
      onClick={(event) => {
        onClick?.(event);
        toggleListening();
      }}
      {...props}
    >
      <MicIcon className="size-4" />
    </PromptInputButton>
  );
}
