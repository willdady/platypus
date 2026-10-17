"use client";

import { useId, useState } from "react";
import type { Widget } from "@platypus/schemas";
import { useResetOnChange } from "@/hooks/use-reset-on-change";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "@/components/markdown";
import { Check } from "lucide-react";
import type { Serialized } from "@/lib/api-write";

export function TextWidget({
  widget,
  editing,
  onSave,
}: {
  widget: Serialized<Widget>;
  editing: boolean;
  onSave: (data: object, title: string) => void;
}) {
  const data = widget.data as { content: string } | null | undefined;
  const id = useId();
  const [title, setTitle] = useState(widget.title);
  const [content, setContent] = useState(data?.content ?? "");

  useResetOnChange(widget.title, () => setTitle(widget.title));
  useResetOnChange(data?.content, () => setContent(data?.content ?? ""));

  if (editing) {
    return (
      <div className="flex flex-col gap-2 p-3 h-full">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-name`} className="text-xs">
            Name
          </Label>
          <Input
            id={`${id}-name`}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="h-7 text-sm"
          />
        </div>
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Markdown content…"
          className="flex-1 min-h-0 resize-none text-sm font-mono"
        />
        <Button size="sm" onClick={() => onSave({ content }, title)}>
          <Check className="size-3" /> Save
        </Button>
      </div>
    );
  }

  return (
    <div className="p-4 h-full overflow-auto">
      {data?.content ? (
        <Markdown>{data.content}</Markdown>
      ) : (
        <p className="text-sm text-muted-foreground italic">No content yet</p>
      )}
    </div>
  );
}
