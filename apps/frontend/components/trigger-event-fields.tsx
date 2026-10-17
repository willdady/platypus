"use client";

import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { useScopedList } from "@/hooks/use-scoped-list";
import { useEffect, useState } from "react";
import {
  eventTriggerEventSchema,
  type KanbanBoard,
  type KanbanBoardState,
} from "@platypus/schemas";
import type { TriggerFieldsProps } from "@/components/trigger-form";

// The events an Event Trigger can subscribe to. Webhook-only events
// (`trigger_run.*`) are not among them.
const AVAILABLE_EVENTS = eventTriggerEventSchema.options;

// Mirrors the fields kanban.ts's changedCardFields diffs (updatedAt,
// lastEditedBy*, and position are bookkeeping and never appear there).
const CHANGED_FIELD_OPTIONS = [
  { value: "title", label: "Title" },
  { value: "body", label: "Body" },
  { value: "labelIds", label: "Labels" },
  { value: "assignees", label: "Assignees" },
  { value: "dueDate", label: "Due date" },
  { value: "priority", label: "Priority" },
] as const;

/** An Event Trigger's events and its board, column and changed-field filters. */
function TriggerEventFields({
  active,
  trigger,
  scope,
  disabled,
  errors,
  clearErrors,
  onChange,
}: TriggerFieldsProps) {
  const saved = trigger?.type === "event" ? trigger.config : undefined;

  const [selectedEvents, setSelectedEvents] = useState<string[]>(
    saved?.events ?? [],
  );
  const [filterBoardId, setFilterBoardId] = useState<string>(
    saved?.filters?.boardId || "",
  );
  const [filterColumnId, setFilterColumnId] = useState<string>(
    saved?.filters?.columnId || "",
  );
  const [filterChangedFields, setFilterChangedFields] = useState<string[]>(
    saved?.filters?.changedFields || [],
  );

  const { results: boards } = useScopedList<KanbanBoard>("boards", scope);
  const { data: boardStateData } = useScopedSWR<KanbanBoardState>(
    `boards/${filterBoardId}/state`,
    filterBoardId ? scope : null,
  );
  const columns = boardStateData?.columns || [];

  useEffect(() => {
    onChange({
      type: "event",
      config: {
        events: selectedEvents,
        ...(filterBoardId || filterChangedFields.length > 0
          ? {
              filters: {
                ...(filterBoardId ? { boardId: filterBoardId } : {}),
                ...(filterBoardId && filterColumnId
                  ? { columnId: filterColumnId }
                  : {}),
                ...(filterChangedFields.length > 0
                  ? { changedFields: filterChangedFields }
                  : {}),
              },
            }
          : {}),
      },
      valid: selectedEvents.length > 0,
    });
  }, [
    onChange,
    selectedEvents,
    filterBoardId,
    filterColumnId,
    filterChangedFields,
  ]);

  if (!active) return null;

  const handleEventToggle = (event: string) => {
    clearErrors("config");
    setSelectedEvents((prev) => {
      const next = prev.includes(event)
        ? prev.filter((e) => e !== event)
        : [...prev, event];
      // Clear board and column filters if no card events remain
      if (!next.some((e) => e.startsWith("card."))) {
        setFilterBoardId("");
        setFilterColumnId("");
      }
      // The changed-fields filter only makes sense against card.updated
      if (!next.includes("card.updated")) {
        setFilterChangedFields([]);
      }
      return next;
    });
  };

  const handleChangedFieldToggle = (field: string) => {
    setFilterChangedFields((prev) =>
      prev.includes(field) ? prev.filter((f) => f !== field) : [...prev, field],
    );
  };

  return (
    <>
      <Field aria-labelledby="trigger-events-label">
        <FieldTitle id="trigger-events-label">Events</FieldTitle>
        <FieldDescription>
          Select the events that will trigger this agent.
        </FieldDescription>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
          {AVAILABLE_EVENTS.map((event) => (
            <Field key={event} orientation="horizontal">
              <Switch
                id={`event-${event}`}
                checked={selectedEvents.includes(event)}
                onCheckedChange={() => handleEventToggle(event)}
                disabled={disabled}
              />
              <FieldLabel htmlFor={`event-${event}`}>{event}</FieldLabel>
            </Field>
          ))}
        </div>
        {errors.config && <FieldError>{errors.config}</FieldError>}
      </Field>

      {/* Board and column filters for card events */}
      {selectedEvents.some((e) => e.startsWith("card.")) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field>
            <FieldLabel htmlFor="trigger-filter-board">
              Only cards in this Board
            </FieldLabel>
            <Select
              value={filterBoardId || "__all__"}
              onValueChange={(value) => {
                setFilterBoardId(value === "__all__" ? "" : value);
                setFilterColumnId("");
              }}
              disabled={disabled}
            >
              <SelectTrigger id="trigger-filter-board" disabled={disabled}>
                <SelectValue placeholder="All boards" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All boards</SelectItem>
                {boards.map((board) => (
                  <SelectItem key={board.id} value={board.id}>
                    {board.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {filterBoardId && (
            <Field>
              <FieldLabel htmlFor="trigger-filter-column">
                Only cards in this Column
              </FieldLabel>
              <Select
                value={filterColumnId || "__all__"}
                onValueChange={(value) =>
                  setFilterColumnId(value === "__all__" ? "" : value)
                }
                disabled={disabled}
              >
                <SelectTrigger id="trigger-filter-column" disabled={disabled}>
                  <SelectValue placeholder="All columns" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All columns</SelectItem>
                  {columns.map((col) => (
                    <SelectItem key={col.id} value={col.id}>
                      {col.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
        </div>
      )}

      {/* Changed-fields filter — only meaningful against card.updated */}
      {selectedEvents.includes("card.updated") && (
        <Field aria-labelledby="trigger-changed-fields-label">
          <FieldTitle id="trigger-changed-fields-label">
            Only when these fields change (card.updated)
          </FieldTitle>
          <FieldDescription>
            Only fire on a card update when one of these fields actually
            changed. Leave all off to fire on any change. Other selected events
            are unaffected — to fire on a column change, select card.moved.
          </FieldDescription>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-2">
            {CHANGED_FIELD_OPTIONS.map((field) => (
              <Field key={field.value} orientation="horizontal">
                <Switch
                  id={`changed-field-${field.value}`}
                  checked={filterChangedFields.includes(field.value)}
                  onCheckedChange={() => handleChangedFieldToggle(field.value)}
                  disabled={disabled}
                />
                <FieldLabel htmlFor={`changed-field-${field.value}`}>
                  {field.label}
                </FieldLabel>
              </Field>
            ))}
          </div>
        </Field>
      )}
    </>
  );
}

export { TriggerEventFields };
