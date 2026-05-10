"use client";

import { useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Widget } from "@platypus/schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Check } from "lucide-react";

export function TextWidget({
  widget,
  editing,
  onSave,
}: {
  widget: Widget;
  editing: boolean;
  onSave: (data: object, title: string) => void;
}) {
  const data = widget.data as { content: string } | null | undefined;
  const [title, setTitle] = useState(widget.title);
  const [content, setContent] = useState(data?.content ?? "");

  useEffect(() => {
    setTitle(widget.title);
  }, [widget.title]);

  useEffect(() => {
    setContent(data?.content ?? "");
  }, [data?.content]);

  if (editing) {
    return (
      <div className="flex flex-col gap-2 p-3 h-full">
        <div className="space-y-1">
          <Label className="text-xs">Name</Label>
          <Input
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
          <Check className="h-3 w-3" /> Save
        </Button>
      </div>
    );
  }

  return (
    <div className="p-4 h-full overflow-auto prose prose-sm dark:prose-invert max-w-none">
      {data?.content ? (
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {data.content}
        </ReactMarkdown>
      ) : (
        <p className="text-sm text-muted-foreground italic">No content yet</p>
      )}
    </div>
  );
}
