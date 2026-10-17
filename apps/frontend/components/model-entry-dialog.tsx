"use client";

import { useState } from "react";
import { Info } from "lucide-react";
import {
  CONTEXT_WINDOW_MAX,
  CONTEXT_WINDOW_MIN,
  DEFAULT_MAX_EXTRACTED_TEXT_CHARS,
  modelConfigSchema,
} from "@platypus/schemas";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ModelConfigView } from "@/lib/model-config";
import {
  CONTEXT_WINDOW_CUSTOM,
  CONTEXT_WINDOW_PRESETS,
  CONTEXT_WINDOW_UNSET,
  contextWindowForOption,
  optionForContextWindow,
  parseContextWindowInput,
} from "@/lib/context-window";
import {
  parseValidationErrors,
  retractFieldError,
  type FormErrors,
} from "@/lib/form-errors";

/**
 * Per-field help for a Model entry. The fields each need a paragraph of
 * explanation, which as one block under the list was a wall nobody read and
 * left the reader matching sentences to fields by hand.
 */
function InfoHint({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    // A short delay, so sweeping the pointer across a row of fields doesn't fire
    // a tooltip at every icon on the way past.
    <Tooltip delayDuration={400}>
      <TooltipTrigger
        // Focusable, so the help is reachable by keyboard and not hover-only.
        type="button"
        aria-label={`About ${label}`}
        className="text-muted-foreground hover:text-foreground focus-visible:border-ring focus-visible:ring-ring/50 rounded-full outline-none focus-visible:ring-[3px]"
      >
        <Info className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{children}</TooltipContent>
    </Tooltip>
  );
}

function ModelField({
  htmlFor,
  label,
  hint,
  error,
  children,
}: {
  htmlFor: string;
  label: string;
  hint: React.ReactNode;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1" data-invalid={!!error}>
      <div className="flex items-center gap-1.5">
        <FieldLabel htmlFor={htmlFor} className="text-xs text-muted-foreground">
          {label}
        </FieldLabel>
        <InfoHint label={label}>{hint}</InfoHint>
      </div>
      {children}
      {error && <FieldError>{error}</FieldError>}
    </div>
  );
}

// Passthrough types are edited as a comma-separated string of media types.
function parsePassthroughTypes(value: string): string[] {
  return value
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

// Shared by the two numeric fields. An empty (or nonsense) value means "unset,
// use the default" rather than 0 — sending 0 would truncate every extracted
// document to nothing (issue #342), and would cap every reply at nothing
// (issue #454). Undefined is also what clears a value already stored: the whole
// `modelIds` array is replaced on save, so the key simply stops being sent.
//
// `Number`, never `Number.parseInt`: parseInt truncates at the first character
// it cannot read, so `1e5` and `1.9` both became 1 — a value the schema
// accepts, which then capped every reply on the model at one token with nothing
// on screen pointing at the field. Anything numeric is passed through EXACTLY
// as typed and a non-integer is left for the schema to reject with a message,
// matching `parseContextWindowInput`.
function parsePositiveNumber(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Adds or edits one Model entry. Submitting only stages the entry into the
 * provider form; nothing is stored until the provider itself is saved, so
 * closing the dialog discards its edits without asking.
 *
 * Only the per-entry rules are checked here. Rules across entries (an alias
 * duplicating another) stay the server's, and come back as `errors`.
 */
export function ModelEntryDialog({
  model,
  errors,
  fileTypesPlaceholder,
  onSubmit,
  onClose,
}: {
  /** The entry to edit; absent to add a new one. */
  model?: ModelConfigView;
  /** Server errors against this entry's fields, keyed by field name. */
  errors?: FormErrors;
  fileTypesPlaceholder: string;
  onSubmit: (model: ModelConfigView) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<ModelConfigView>(
    model ?? { id: "", passthroughFileTypes: [] },
  );
  // Held as typed: parsing on every keystroke would drop a trailing comma the
  // moment it was typed, so a second type could never be entered.
  const [fileTypesText, setFileTypesText] = useState(
    draft.passthroughFileTypes.join(", "),
  );
  const [fieldErrors, setFieldErrors] = useState<FormErrors>(errors ?? {});

  // Whether the Context window is being typed rather than picked. State as well
  // as derivation, because neither alone is enough: Custom chosen with no window
  // declared leaves the value undefined, so a purely derived control would snap
  // back to "Not set" and the input the reader just asked for would vanish the
  // moment they cleared it.
  const [customContextWindow, setCustomContextWindow] = useState(
    optionForContextWindow(draft.contextWindow) === CONTEXT_WINDOW_CUSTOM,
  );
  const storedContextWindowOption = optionForContextWindow(draft.contextWindow);
  const contextWindowOption =
    customContextWindow || storedContextWindowOption === CONTEXT_WINDOW_CUSTOM
      ? CONTEXT_WINDOW_CUSTOM
      : storedContextWindowOption;

  const update = <K extends keyof ModelConfigView>(
    field: K,
    value: ModelConfigView[K],
  ) => {
    setDraft((prev) => ({ ...prev, [field]: value }));
    setFieldErrors((prev) => retractFieldError(prev, field));
  };

  const handleSubmit = () => {
    // Same keys as the entry it came from, so Save with nothing changed leaves
    // the provider form clean.
    const entry = {
      ...draft,
      passthroughFileTypes: parsePassthroughTypes(fileTypesText),
    };
    const result = modelConfigSchema.safeParse(entry);
    if (!result.success) {
      setFieldErrors(parseValidationErrors({ error: result.error.issues }));
      return;
    }
    onSubmit(entry);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{model ? "Edit model" : "Add model"}</DialogTitle>
          <DialogDescription>
            Nothing is stored until you save the provider.
          </DialogDescription>
        </DialogHeader>

        <FieldSet>
          <FieldGroup className="gap-3">
            <ModelField
              htmlFor="model-id"
              label="Model ID"
              hint="The model id sent to the vendor, exactly as the vendor names it."
              error={fieldErrors.id}
            >
              <Input
                // Focused on open, so the dialog doesn't land on the info
                // button before it, open its tooltip and spend the first Esc.
                autoFocus
                id="model-id"
                placeholder="e.g. gpt-4o"
                value={draft.id}
                onChange={(e) => update("id", e.target.value)}
                aria-invalid={!!fieldErrors.id}
              />
            </ModelField>

            <ModelField
              htmlFor="model-alias"
              label="Alias"
              hint="Optional stable name Agents and Chats can select instead of the model ID. Pointing the alias at a newer model upgrades all of them at once."
              error={fieldErrors.alias}
            >
              <Input
                id="model-alias"
                placeholder="e.g. flagship"
                value={draft.alias ?? ""}
                aria-invalid={!!fieldErrors.alias}
                onChange={(e) =>
                  // An empty field means "no alias". Anything else goes to the
                  // schema as typed, so a whitespace-only name is rejected
                  // rather than silently dropped.
                  update(
                    "alias",
                    e.target.value === "" ? undefined : e.target.value,
                  )
                }
              />
            </ModelField>

            <ModelField
              htmlFor="model-context-window"
              label="Context window"
              hint={
                <>
                  The model&apos;s <strong>total</strong> token capacity, not a
                  cap on the reply. Listed sizes are decimal, so{" "}
                  <code>128k</code> is 128,000. Optional; without it a Chat on
                  this model shows no context meter.
                </>
              }
              error={fieldErrors.contextWindow}
            >
              <div className="flex items-center gap-2">
                <Select
                  value={contextWindowOption}
                  onValueChange={(value) => {
                    setCustomContextWindow(value === CONTEXT_WINDOW_CUSTOM);
                    update(
                      "contextWindow",
                      contextWindowForOption(value, draft.contextWindow),
                    );
                  }}
                >
                  <SelectTrigger
                    id="model-context-window"
                    aria-invalid={!!fieldErrors.contextWindow}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={CONTEXT_WINDOW_UNSET}>
                      Not set
                    </SelectItem>
                    {CONTEXT_WINDOW_PRESETS.map((preset) => (
                      <SelectItem
                        key={preset.tokens}
                        value={String(preset.tokens)}
                      >
                        {preset.label}
                      </SelectItem>
                    ))}
                    <SelectItem value={CONTEXT_WINDOW_CUSTOM}>
                      Custom
                    </SelectItem>
                  </SelectContent>
                </Select>
                {contextWindowOption === CONTEXT_WINDOW_CUSTOM && (
                  <Input
                    aria-label="Context window in tokens"
                    type="number"
                    min={CONTEXT_WINDOW_MIN}
                    max={CONTEXT_WINDOW_MAX}
                    placeholder="e.g. 131072"
                    className="flex-1"
                    value={draft.contextWindow ?? ""}
                    aria-invalid={!!fieldErrors.contextWindow}
                    onChange={(e) =>
                      update(
                        "contextWindow",
                        parseContextWindowInput(e.target.value),
                      )
                    }
                  />
                )}
              </div>
            </ModelField>

            <ModelField
              htmlFor="model-passthrough"
              label="Native file types"
              hint={
                <>
                  Media types this model ingests <strong>natively</strong>,
                  comma-separated (wildcards like <code>image/*</code> allowed).
                  Other types are converted to text where possible, so this is a
                  capability setting, <strong>not a security filter</strong>.
                  Leave empty to use the provider-type default.
                </>
              }
              error={fieldErrors.passthroughFileTypes}
            >
              <Input
                id="model-passthrough"
                placeholder={fileTypesPlaceholder}
                value={fileTypesText}
                aria-invalid={!!fieldErrors.passthroughFileTypes}
                onChange={(e) => {
                  setFileTypesText(e.target.value);
                  setFieldErrors((prev) =>
                    retractFieldError(prev, "passthroughFileTypes"),
                  );
                }}
              />
            </ModelField>

            <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2">
              <ModelField
                htmlFor="model-extracted-chars"
                label="Max extracted text characters"
                hint="How much extracted document text a single file may add to a turn. Protects a small context window. Leave empty for the default."
                error={fieldErrors.maxExtractedTextChars}
              >
                <Input
                  id="model-extracted-chars"
                  type="number"
                  min={1}
                  placeholder={String(DEFAULT_MAX_EXTRACTED_TEXT_CHARS)}
                  value={draft.maxExtractedTextChars ?? ""}
                  aria-invalid={!!fieldErrors.maxExtractedTextChars}
                  onChange={(e) =>
                    update(
                      "maxExtractedTextChars",
                      parsePositiveNumber(e.target.value),
                    )
                  }
                />
              </ModelField>

              <ModelField
                htmlFor="model-max-output-tokens"
                label="Max output tokens"
                hint={
                  <>
                    The most this model may produce in a{" "}
                    <strong>single reply</strong> — a cap on the answer, not the
                    window. Leave empty to use the vendor’s own default, which
                    may be well below what the model can actually write.
                  </>
                }
                error={fieldErrors.maxOutputTokens}
              >
                <Input
                  id="model-max-output-tokens"
                  type="number"
                  min={1}
                  placeholder="Provider default"
                  value={draft.maxOutputTokens ?? ""}
                  aria-invalid={!!fieldErrors.maxOutputTokens}
                  onChange={(e) =>
                    update(
                      "maxOutputTokens",
                      parsePositiveNumber(e.target.value),
                    )
                  }
                />
              </ModelField>
            </div>
          </FieldGroup>
        </FieldSet>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSubmit}>{model ? "Save" : "Add"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
