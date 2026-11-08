import { Search, X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type SearchInputProps = Omit<
  React.ComponentProps<typeof Input>,
  "type" | "value" | "onChange"
> & {
  value: string;
  onValueChange: (value: string) => void;
  /** Required: the placeholder alone is not an accessible name. */
  "aria-label": string;
  /** Applied to the wrapper; use `inputClassName` for the input itself. */
  className?: string;
  inputClassName?: string;
};

function SearchInput({
  value,
  onValueChange,
  className,
  inputClassName,
  onKeyDown,
  ...props
}: SearchInputProps) {
  return (
    <div className={cn("relative", className)}>
      <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
      <Input
        type="search"
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={(e) => {
          // A search filters as it is typed, so Enter must not save the form
          // this field happens to sit in.
          if (e.key === "Enter") e.preventDefault();
          onKeyDown?.(e);
        }}
        // Hide the browser's own clear button; the X below replaces it.
        className={cn(
          "px-8 [&::-webkit-search-cancel-button]:appearance-none",
          inputClassName,
        )}
        {...props}
      />
      {value && (
        <button
          type="button"
          onClick={() => onValueChange("")}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}

export { SearchInput };
