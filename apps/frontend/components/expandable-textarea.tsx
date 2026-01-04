"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "motion/react";
import { Maximize2, Minimize2 } from "lucide-react";
import { Textarea } from "./ui/textarea";
import { FieldError, FieldLabel } from "./ui/field";
import { Button } from "./ui/button";
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
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const layoutId = React.useId();
  const currentLength = typeof value === "string" ? value.length : 0;

  const toggleExpand = () => setIsExpanded(!isExpanded);

  React.useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isExpanded) {
        setIsExpanded(false);
      }
    };
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, [isExpanded]);

  const renderTextarea = (expanded: boolean) => (
    <Textarea
      className={cn(
        "resize-none",
        expanded ? "h-full min-h-[300px]" : "min-h-16 max-h-[15em]",
        className,
      )}
      maxLength={maxLength}
      value={value}
      onChange={onChange}
      id={id}
      ref={expanded ? textareaRef : undefined}
      {...props}
    />
  );

  const counterElement = (maxLength !== undefined || error) && (
    <div className="flex justify-between mt-1">
      {error ? <FieldError>{error}</FieldError> : <div />}
      {maxLength !== undefined && (
        <p className="text-xs text-muted-foreground">
          {currentLength}/{maxLength}
        </p>
      )}
    </div>
  );

  return (
    <>
      <div className="relative w-full group flex flex-col">
        {label && !isExpanded && (
          <div className="flex justify-between items-center mb-2">
            <FieldLabel htmlFor={id}>{label}</FieldLabel>
            {expandable && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 cursor-pointer text-muted-foreground"
                onClick={toggleExpand}
              >
                <Maximize2 className="size-3.5" />
                <span className="sr-only">Expand</span>
              </Button>
            )}
          </div>
        )}
        {!isExpanded && (
          <motion.div
            layoutId={layoutId}
            transition={{ duration: 0.2 }}
            className="w-full relative"
          >
            {renderTextarea(false)}
            {!label && expandable && (
              <div className="absolute top-2 right-2 flex gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-6 cursor-pointer text-muted-foreground"
                  onClick={toggleExpand}
                >
                  <Maximize2 className="size-3.5" />
                  <span className="sr-only">Expand</span>
                </Button>
              </div>
            )}
            {counterElement}
          </motion.div>
        )}
        {isExpanded && (
          <div className="invisible">
            {label && (
              <div className="flex justify-between items-center mb-2">
                <FieldLabel htmlFor={id}>{label}</FieldLabel>
                <div className="size-6" />
              </div>
            )}
            {renderTextarea(false)}
            {counterElement}
          </div>
        )}
      </div>

      {expandable &&
        typeof document !== "undefined" &&
        createPortal(
          <AnimatePresence>
            {isExpanded && (
              <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8">
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="absolute inset-0 bg-black/50 backdrop-blur-[2px]"
                  onClick={toggleExpand}
                />
                <motion.div
                  layoutId={layoutId}
                  transition={{ duration: 0.2 }}
                  onLayoutAnimationComplete={() => {
                    if (isExpanded) {
                      textareaRef.current?.focus();
                    }
                  }}
                  className="relative w-full max-w-5xl h-full max-h-[80vh] bg-background rounded-lg border shadow-2xl flex flex-col p-4"
                >
                  <div className="flex justify-between items-center mb-2">
                    <div className="text-sm font-medium text-muted-foreground">
                      {label || "Full Screen Editor"}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-6 cursor-pointer text-muted-foreground"
                      onClick={toggleExpand}
                    >
                      <Minimize2 className="size-3.5" />
                      <span className="sr-only">Collapse</span>
                    </Button>
                  </div>
                  <div className="flex-1 overflow-hidden">
                    {renderTextarea(true)}
                  </div>
                  {counterElement}
                </motion.div>
              </div>
            )}
          </AnimatePresence>,
          document.body,
        )}
    </>
  );
}

export { ExpandableTextarea };
