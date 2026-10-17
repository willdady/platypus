"use client";

import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// Rows are kept as an ordered array (not a Record) so a user can edit keys, add
// empties, and tolerate duplicate-during-edit without the UI reshuffling on
// every keystroke. The id is the React key: keyed by index, removing row N
// would hand row N's DOM and local state to row N+1 (#1468).
export type KeyValueRow = { id: string; key: string; value: string };

// A counter, not crypto.randomUUID: that needs a secure context, and a
// self-hosted install may be served over plain http.
let lastRowId = 0;

export function newRow(key = "", value = ""): KeyValueRow {
  return {
    id: String(++lastRowId),
    key,
    value,
  };
}

export function recordToRows(
  rec: Record<string, string> | null | undefined,
): KeyValueRow[] {
  return Object.entries(rec ?? {}).map(([key, value]) => newRow(key, value));
}

/** Trims keys and drops rows without one; `empty` is returned when none remain. */
export function rowsToRecord<E>(
  rows: KeyValueRow[],
  empty: E,
): Record<string, string> | E {
  const out: Record<string, string> = {};
  for (const { key, value } of rows) {
    const trimmedKey = key.trim();
    if (trimmedKey === "") continue;
    out[trimmedKey] = value;
  }
  return Object.keys(out).length > 0 ? out : empty;
}

export type RowAriaLabels = {
  key: (n: number) => string;
  value: (n: number) => string;
  remove: (n: number) => string;
};

export const HEADER_ROW_LABELS: RowAriaLabels = {
  key: (n) => `Header ${n} name`,
  value: (n) => `Header ${n} value`,
  remove: () => "Remove header",
};

export function KeyValueRowsEditor({
  rows,
  onChange,
  disabled,
  readOnly,
  keyPlaceholder,
  valuePlaceholder,
  labels,
  addLabel,
  maskValue,
  mono,
  rowError,
}: {
  rows: KeyValueRow[];
  /** `changed` is the edited or removed row as it was before; absent on add. */
  onChange: (rows: KeyValueRow[], changed?: KeyValueRow) => void;
  disabled?: boolean;
  readOnly?: boolean;
  keyPlaceholder: string;
  valuePlaceholder: string;
  /** Defaults to the placeholder and row number, and "Remove row N". */
  labels?: RowAriaLabels;
  addLabel: string;
  maskValue?: boolean;
  mono?: boolean;
  rowError?: (row: KeyValueRow) => string | undefined;
}) {
  const ariaLabels = labels ?? {
    key: (n: number) => `${keyPlaceholder} ${n}`,
    value: (n: number) => `${valuePlaceholder} ${n}`,
    remove: (n: number) => `Remove row ${n}`,
  };
  const update = (row: KeyValueRow, field: "key" | "value", text: string) =>
    onChange(
      rows.map((r) => (r.id === row.id ? { ...r, [field]: text } : r)),
      row,
    );

  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, idx) => {
        const error = rowError?.(row);
        return (
          <div key={row.id} className="flex flex-col gap-1">
            <div className="flex gap-2 items-center">
              <Input
                placeholder={keyPlaceholder}
                value={row.key}
                aria-label={ariaLabels.key(idx + 1)}
                aria-invalid={!!error || undefined}
                disabled={disabled || readOnly}
                onChange={(e) => update(row, "key", e.target.value)}
                className={cn(mono && "font-mono")}
              />
              <Input
                placeholder={valuePlaceholder}
                value={row.value}
                aria-label={ariaLabels.value(idx + 1)}
                aria-invalid={!!error || undefined}
                disabled={disabled || readOnly}
                type={maskValue ? "password" : "text"}
                autoComplete="off"
                onChange={(e) => update(row, "value", e.target.value)}
                className={cn(mono && "font-mono")}
              />
              {!readOnly && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={ariaLabels.remove(idx + 1)}
                  className="shrink-0"
                  disabled={disabled}
                  onClick={() =>
                    onChange(
                      rows.filter((r) => r.id !== row.id),
                      row,
                    )
                  }
                >
                  <X />
                </Button>
              )}
            </div>
            {error && <FieldError>{error}</FieldError>}
          </div>
        );
      })}
      {!readOnly && (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => onChange([...rows, newRow()])}
          >
            <Plus /> {addLabel}
          </Button>
        </div>
      )}
    </div>
  );
}
