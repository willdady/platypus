import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export type FormFooterButtonsProps = {
  submitText: string;
  onSubmit?: () => void;
  submitDisabled?: boolean;
  submitClassName?: string;
  deleteVisible?: boolean;
  deleteDisabled?: boolean;
  deleteClassName?: string;
  onDelete?: () => void;
  type?: "button" | "submit";
};

export const FormFooterButtons = ({
  submitText,
  onSubmit,
  submitDisabled,
  submitClassName = "cursor-pointer",
  deleteVisible = false,
  deleteDisabled,
  deleteClassName = "cursor-pointer",
  onDelete,
  type = "button",
}: FormFooterButtonsProps) => {
  return (
    <div className="flex gap-2">
      <Button
        type={type}
        className={submitClassName}
        onClick={type === "button" ? onSubmit : undefined}
        disabled={submitDisabled}
      >
        {submitText}
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
};
