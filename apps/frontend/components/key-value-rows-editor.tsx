"use client";

import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type KeyValueRow = { id: string; key: string; value: string };

// why: crypto.randomUUID needs a secure context, and a self-host may serve plain http
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

export function findDuplicateKey(
  rows: KeyValueRow[],
  { caseSensitive = true }: { caseSensitive?: boolean } = {},
): string | null {
  const seen = new Set<string>();
  for (const { key } of rows) {
    const trimmed = key.trim();
    if (trimmed === "") continue;
    const normalized = caseSensitive ? trimmed : trimmed.toLowerCase();
    if (seen.has(normalized)) return trimmed;
    seen.add(normalized);
  }
  return null;
}

export function duplicateHeaderError(rows: KeyValueRow[]): string | null {
  const duplicate = findDuplicateKey(rows, { caseSensitive: false });
  return duplicate
    ? `Duplicate header name "${duplicate}". Header names are case-insensitive, so each one may appear once.`
    : null;
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
  onChange: (rows: KeyValueRow[], changed?: KeyValueRow) => void;
  disabled?: boolean;
  readOnly?: boolean;
  keyPlaceholder: string;
  valuePlaceholder: string;
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
