import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/** The label a submit button shows while its form is saving. */
export const PENDING_SUBMIT_TEXT = {
  Save: "Saving...",
  Update: "Updating...",
} as const;

export type FormFooterButtonsProps = {
  submitText: keyof typeof PENDING_SUBMIT_TEXT;
  pending?: boolean;
  onSubmit?: () => void;
  submitDisabled?: boolean;
  submitClassName?: string;
  deleteVisible?: boolean;
  deleteDisabled?: boolean;
  deleteClassName?: string;
  onDelete?: () => void;
  type?: "button" | "submit";
};

export function FormFooterButtons({
  submitText,
  pending = false,
  onSubmit,
  submitDisabled,
  submitClassName,
  deleteVisible = false,
  deleteDisabled,
  deleteClassName,
  onDelete,
  type = "button",
}: FormFooterButtonsProps) {
  return (
    <div className="flex gap-2">
      <Button
        type={type}
        className={submitClassName}
        onClick={type === "button" ? onSubmit : undefined}
        disabled={submitDisabled || pending}
      >
        {pending ? PENDING_SUBMIT_TEXT[submitText] : submitText}
      </Button>

      {deleteVisible && (
        <Button
          type="button"
          variant="outline"
          className={deleteClassName}
          onClick={onDelete}
          disabled={deleteDisabled}
        >
          <Trash2 /> Delete
        </Button>
      )}
    </div>
  );
}
