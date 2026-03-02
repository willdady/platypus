"use client";

import { useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { KanbanCard, KanbanLabel } from "@platypus/schemas";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function KanbanCardDialog({
  card,
  labels,
  open,
  onOpenChange,
  onSave,
  onDelete,
}: {
  card: KanbanCard | null;
  labels: KanbanLabel[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (
    cardId: string,
    data: { title?: string; body?: string; labelIds?: string[] },
  ) => void;
  onDelete: (cardId: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>([]);
  const [isEditing, setIsEditing] = useState(false);
  const [focusField, setFocusField] = useState<"title" | "body">("title");

  const enterEditing = (field: "title" | "body") => {
    setFocusField(field);
    setIsEditing(true);
  };

  useEffect(() => {
    if (card) {
      setTitle(card.title);
      setBody(card.body ?? "");
      setSelectedLabelIds(card.labelIds ?? []);
      setIsEditing(false);
    }
  }, [card]);

  if (!card) return null;

  const toggleLabel = (labelId: string) => {
    setSelectedLabelIds((prev) =>
      prev.includes(labelId)
        ? prev.filter((id) => id !== labelId)
        : [...prev, labelId],
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>Edit Card</DialogTitle>
        </DialogHeader>
        <div className="flex gap-4 min-h-0 flex-1">
          {/* Main content - Title and Body */}
          <div
            className="flex-1 min-w-0 space-y-4 overflow-y-auto pr-3"
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget)) {
                setIsEditing(false);
              }
            }}
          >
            {isEditing ? (
              <Input
                autoFocus={focusField === "title"}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="text-lg font-semibold"
                placeholder="Card title"
              />
            ) : (
              <h2
                className="text-lg font-semibold cursor-pointer"
                onClick={() => enterEditing("title")}
              >
                {title}
              </h2>
            )}
            {isEditing ? (
              <Textarea
                autoFocus={focusField === "body"}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Add a description..."
                rows={6}
                className="min-h-[150px]"
              />
            ) : body ? (
              <div
                className="prose prose-sm dark:prose-invert max-w-none cursor-pointer min-h-[150px]"
                onClick={() => enterEditing("body")}
              >
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {body}
                </ReactMarkdown>
              </div>
            ) : (
              <p
                className="text-sm text-muted-foreground cursor-pointer min-h-[150px] hover:text-foreground"
                onClick={() => enterEditing("body")}
              >
                Click to add a description...
              </p>
            )}
          </div>

          {/* Sidebar - Labels and Metadata */}
          <div className="w-48 shrink-0 space-y-4">
            {labels.length > 0 && <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">
                Labels
              </p>
              <div className="flex flex-wrap gap-1.5">
                {labels.map((label) => {
                  const isActive = selectedLabelIds.includes(label.id);
                  return (
                    <Badge
                      key={label.id}
                      className={cn(
                        "cursor-pointer transition-opacity border-0",
                        !isActive && "opacity-40",
                      )}
                      style={{ backgroundColor: label.color }}
                      onClick={() => toggleLabel(label.id)}
                    >
                      {label.name}
                    </Badge>
                  );
                })}
              </div>
            </div>}

            <div className="text-xs text-muted-foreground space-y-1.5">
              {card.createdByName && (
                <p>
                  <span className="font-medium">Created by:</span>{" "}
                  {card.createdByName}
                </p>
              )}
              {card.lastEditedByName && (
                <p>
                  <span className="font-medium">Last edited by:</span>{" "}
                  {card.lastEditedByName}
                </p>
              )}
            </div>
          </div>
        </div>
        <DialogFooter className="shrink-0">
          <Button variant="destructive" onClick={() => onDelete(card.id)}>
            Delete
          </Button>
          <Button
            onClick={() =>
              onSave(card.id, { title, body, labelIds: selectedLabelIds })
            }
            disabled={!title.trim()}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
