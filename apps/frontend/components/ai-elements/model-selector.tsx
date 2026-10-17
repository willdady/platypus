import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { ComponentProps, ReactNode } from "react";

export type ModelSelectorProps = ComponentProps<typeof Dialog>;

export function ModelSelector(props: ModelSelectorProps) {
  return <Dialog {...props} />;
}

export type ModelSelectorTriggerProps = ComponentProps<typeof DialogTrigger>;

export function ModelSelectorTrigger(props: ModelSelectorTriggerProps) {
  return <DialogTrigger {...props} />;
}

export type ModelSelectorContentProps = ComponentProps<typeof DialogContent> & {
  title?: ReactNode;
  filter?: ComponentProps<typeof Command>["filter"];
};

export function ModelSelectorContent({
  className,
  children,
  title = "Model Selector",
  filter,
  ...props
}: ModelSelectorContentProps) {
  return (
    <DialogContent className={cn("p-0", className)} {...props}>
      <DialogTitle className="sr-only">{title}</DialogTitle>
      <Command
        className="**:data-[slot=command-input-wrapper]:h-auto"
        filter={filter}
      >
        {children}
      </Command>
    </DialogContent>
  );
}

export type ModelSelectorInputProps = ComponentProps<typeof CommandInput>;

export function ModelSelectorInput({
  className,
  ...props
}: ModelSelectorInputProps) {
  return <CommandInput className={cn("h-auto py-3.5", className)} {...props} />;
}

export type ModelSelectorListProps = ComponentProps<typeof CommandList>;

export function ModelSelectorList(props: ModelSelectorListProps) {
  return <CommandList {...props} />;
}

export type ModelSelectorEmptyProps = ComponentProps<typeof CommandEmpty>;

export function ModelSelectorEmpty(props: ModelSelectorEmptyProps) {
  return <CommandEmpty {...props} />;
}

export type ModelSelectorGroupProps = ComponentProps<typeof CommandGroup>;

export function ModelSelectorGroup(props: ModelSelectorGroupProps) {
  return <CommandGroup {...props} />;
}

export type ModelSelectorItemProps = ComponentProps<typeof CommandItem>;

export function ModelSelectorItem(props: ModelSelectorItemProps) {
  return <CommandItem {...props} />;
}
