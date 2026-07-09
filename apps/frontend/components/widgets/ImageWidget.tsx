"use client";

import { useState } from "react";
import type { Widget } from "@platypus/schemas";
import { useResetOnChange } from "@/hooks/use-reset-on-change";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Check } from "lucide-react";

export function ImageWidget({
  widget,
  editing,
  onSave,
}: {
  widget: Widget;
  editing: boolean;
  onSave: (data: object, title: string) => void;
}) {
  const data = widget.data as { url: string } | null | undefined;
  const [title, setTitle] = useState(widget.title);
  const [url, setUrl] = useState(data?.url ?? "");

  useResetOnChange(widget.title, () => setTitle(widget.title));
  useResetOnChange(data?.url, () => setUrl(data?.url ?? ""));

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
        <div className="space-y-1">
          <Label className="text-xs">Image URL</Label>
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://… or data:image/…"
            className="h-7 text-sm"
          />
        </div>
        <Button
          size="sm"
          className="mt-auto"
          onClick={() => onSave({ url }, title)}
        >
          <Check className="h-3 w-3" /> Save
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center h-full p-2">
      {data?.url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={data.url}
          alt={widget.title}
          className="w-full h-full object-contain"
        />
      ) : (
        <p className="text-sm text-muted-foreground italic">No image yet</p>
      )}
    </div>
  );
}
