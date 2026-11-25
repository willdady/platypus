"use client";

import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TIMEZONES } from "@/lib/timezones";
import { cn } from "@/lib/utils";

const TIMEZONE_PAGE_SIZE = 50;

function normaliseTimezone(value: string) {
  return value.toLowerCase().replace(/[_/]+/g, " ");
}

function matchesTimezone(timezone: string, query: string) {
  const needle = normaliseTimezone(query.trim());
  return !needle || normaliseTimezone(timezone).includes(needle);
}

function pageTimezones(query: string, selected: string | null, limit: number) {
  const matches = TIMEZONES.filter((tz) => matchesTimezone(tz, query));
  const page = matches.slice(0, limit);
  const pinned =
    !query.trim() && selected && !page.includes(selected) ? selected : null;
  return {
    options: pinned ? [pinned, ...page.slice(0, limit - 1)] : page,
    matchCount: matches.length,
    hasMore: matches.length > page.length,
  };
}

export function TimezoneCombobox({
  id,
  value,
  onChange,
  disabled,
  invalid,
  describedBy,
}: {
  id?: string;
  value: string | null;
  onChange: (value: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(TIMEZONE_PAGE_SIZE);

  const { options, matchCount, hasMore } = pageTimezones(query, value, limit);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setQuery("");
      setLimit(TIMEZONE_PAGE_SIZE);
    }
  }

  function handleQueryChange(next: string) {
    setQuery(next);
    setLimit(TIMEZONE_PAGE_SIZE);
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          disabled={disabled}
          className="w-full justify-between font-normal"
        >
          <span className={cn(!value && "text-muted-foreground")}>
            {value ?? "Not set"}
          </span>
          <ChevronsUpDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) p-0">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search timezones..."
            value={query}
            onValueChange={handleQueryChange}
          />
          <CommandList>
            {options.length > 0 ? (
              <CommandGroup>
                {options.map((tz) => (
                  <CommandItem
                    key={tz}
                    value={tz}
                    onSelect={() => {
                      onChange(tz);
                      handleOpenChange(false);
                    }}
                  >
                    <Check
                      className={cn(
                        "mr-2 size-4",
                        tz === value ? "opacity-100" : "opacity-0",
                      )}
                    />
                    {tz}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : (
              <CommandEmpty>No timezones found.</CommandEmpty>
            )}
          </CommandList>
          {hasMore && (
            <div className="flex items-center justify-between gap-2 border-t px-2 py-1.5">
              <p className="text-muted-foreground text-xs">
                Showing {options.length} of {matchCount}.
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setLimit((count) => count + TIMEZONE_PAGE_SIZE)}
              >
                Show more
              </Button>
            </div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}
