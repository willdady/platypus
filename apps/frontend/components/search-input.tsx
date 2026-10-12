import { Search, X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type SearchInputProps = Omit<
  React.ComponentProps<typeof Input>,
  "type" | "value" | "onChange"
> & {
  value: string;
  onValueChange: (value: string) => void;
  /** Applied to the wrapper; use `inputClassName` for the input itself. */
  className?: string;
  inputClassName?: string;
};

function SearchInput({
  value,
  onValueChange,
  className,
  inputClassName,
  ...props
}: SearchInputProps) {
  return (
    <div className={cn("relative", className)}>
      <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
      <Input
        type="search"
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        // Hide the browser's own clear button; the X below replaces it.
        className={cn(
          "pl-8 pr-8 [&::-webkit-search-cancel-button]:appearance-none",
          inputClassName,
        )}
        {...props}
      />
      {value && (
        <button
          type="button"
          onClick={() => onValueChange("")}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground cursor-pointer"
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}

export { SearchInput };
