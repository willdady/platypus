"use client";

import * as React from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { Markdown } from "@/components/markdown";
import { Textarea } from "./ui/textarea";
import { FieldError, FieldLabel } from "./ui/field";
import { Button } from "./ui/button";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "./ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { cn } from "@/lib/utils";

interface ExpandableTextareaProps extends React.ComponentProps<
  typeof Textarea
> {
  label?: string;
  error?: string;
  expandable?: boolean;
}

function ExpandableTextarea({
  className,
  maxLength,
  value,
  error,
  label,
  expandable = true,
  onChange,
  id,
  ...props
}: ExpandableTextareaProps) {
  const [isExpanded, setIsExpanded] = React.useState(false);
  const [activeTab, setActiveTab] = React.useState<"write" | "preview">(
    "write",
  );
  const [draftValue, setDraftValue] = React.useState("");
  const expandButtonRef = React.useRef<HTMLButtonElement>(null);

  const commitDraft = () => {
    if (onChange && draftValue !== value) {
      const event = {
        target: { value: draftValue, id: id ?? "" },
      } as React.ChangeEvent<HTMLTextAreaElement>;
      onChange(event);
    }
  };

  const openExpanded = () => {
    setDraftValue(typeof value === "string" ? value : "");
    setActiveTab("write");
    setIsExpanded(true);
  };

  // Every way out — Collapse, Escape, a click outside — keeps the draft.
  const handleOpenChange = (open: boolean) => {
    if (open) return;
    commitDraft();
    setIsExpanded(false);
  };

  const renderCounter = (text: unknown) =>
    (maxLength !== undefined || error) && (
      <div className="flex justify-between mt-1">
        {error ? <FieldError>{error}</FieldError> : <div />}
        {maxLength !== undefined && (
          <p className="text-xs text-muted-foreground">
            {typeof text === "string" ? text.length : 0}/{maxLength}
          </p>
        )}
      </div>
    );

  const expandButton = expandable && (
    <Button
      type="button"
      variant="ghost"
      size="icon-2xs"
      className="text-muted-foreground"
      onClick={openExpanded}
      ref={expandButtonRef}
    >
      <Maximize2 className="size-3.5" />
      <span className="sr-only">Expand</span>
    </Button>
  );

  const title = label || "Full Screen Editor";

  return (
    <>
      <div className="relative w-full group flex flex-col">
        {label && (
          <div className="flex justify-between items-center mb-2">
            <FieldLabel htmlFor={id}>{label}</FieldLabel>
            {expandButton}
          </div>
        )}
        <div className="w-full relative">
          <Textarea
            className={cn("resize-none min-h-16 max-h-[15em]", className)}
            maxLength={maxLength}
            value={value}
            onChange={onChange}
            id={id}
            {...props}
          />
          {!label && expandButton && (
            <div className="absolute top-2 right-2 flex gap-1">
              {expandButton}
            </div>
          )}
          {renderCounter(value)}
        </div>
      </div>

      {expandable && (
        <Dialog open={isExpanded} onOpenChange={handleOpenChange}>
          <DialogContent
            showCloseButton={false}
            aria-describedby={undefined}
            // Opened without a Dialog.Trigger, so Radix has nowhere to send
            // focus back to; return it to Expand.
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              expandButtonRef.current?.focus();
            }}
            className="flex flex-col gap-0 w-full max-w-5xl sm:max-w-5xl h-full max-h-[80vh] p-4"
          >
            <div className="flex justify-between items-center mb-2">
              <DialogTitle className="text-sm font-medium text-muted-foreground">
                {title}
              </DialogTitle>
              <DialogClose asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-2xs"
                  className="text-muted-foreground"
                >
                  <Minimize2 className="size-3.5" />
                  <span className="sr-only">Collapse</span>
                </Button>
              </DialogClose>
            </div>
            <Tabs
              value={activeTab}
              onValueChange={(tab) => setActiveTab(tab as "write" | "preview")}
              className="flex-1 min-h-0 flex flex-col"
            >
              <TabsList className="h-auto self-start mb-2 p-0.5">
                <TabsTrigger value="write" className="px-2 py-0.5 text-xs">
                  Write
                </TabsTrigger>
                <TabsTrigger value="preview" className="px-2 py-0.5 text-xs">
                  Preview
                </TabsTrigger>
              </TabsList>
              <TabsContent value="write" className="mt-0 flex-1 min-h-0">
                <Textarea
                  className={cn("resize-none h-full min-h-[300px]", className)}
                  maxLength={maxLength}
                  value={draftValue}
                  onChange={(e) => setDraftValue(e.target.value)}
                  id={id ? `${id}-expanded` : undefined}
                  aria-label={title}
                  {...props}
                />
              </TabsContent>
              <TabsContent
                value="preview"
                className="mt-0 flex-1 min-h-0 overflow-y-auto rounded-md border bg-transparent px-3 py-2"
              >
                {draftValue.length > 0 ? (
                  <div className="[overflow-wrap:anywhere]">
                    <Markdown>{draftValue}</Markdown>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Nothing to preview
                  </p>
                )}
              </TabsContent>
            </Tabs>
            {renderCounter(draftValue)}
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

export { ExpandableTextarea };
