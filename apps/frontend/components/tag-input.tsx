"use client";

import * as React from "react";
import { X } from "lucide-react";
import { motion } from "motion/react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface TagInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  maxTags?: number;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

const KEBAB_CASE_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function TagInput({
  value = [],
  onChange,
  maxTags = 5,
  placeholder = "Add tag...",
  disabled = false,
  className,
}: TagInputProps) {
  const [inputValue, setInputValue] = React.useState("");
  const [flashingTag, setFlashingTag] = React.useState<string | null>(null);

  const addTag = (tag: string) => {
    const trimmedTag = tag.trim().toLowerCase();
    if (!trimmedTag) return;

    if (value.length >= maxTags) return;

    if (value.includes(trimmedTag)) {
      setFlashingTag(trimmedTag);
      setTimeout(() => setFlashingTag(null), 1000);
      setInputValue("");
      return;
    }

    if (!KEBAB_CASE_REGEX.test(trimmedTag)) return;

    onChange([...value, trimmedTag]);
    setInputValue("");
  };

  const removeTag = (tagToRemove: string) => {
    onChange(value.filter((tag) => tag !== tagToRemove));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag(inputValue);
    } else if (e.key === "Backspace" && !inputValue && value.length > 0) {
      removeTag(value[value.length - 1]);
    }
  };

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex flex-wrap gap-2">
        {value.map((tag) => (
          <motion.div
            key={tag}
            animate={
              flashingTag === tag
                ? {
                    opacity: [1, 0, 1, 0, 1],
                  }
                : { opacity: 1 }
            }
            transition={{ duration: 0.8 }}
          >
            <Badge variant="secondary" className="gap-1 pr-1">
              {tag}
              <button
                type="button"
                onClick={() => removeTag(tag)}
                disabled={disabled}
                className="rounded-full outline-none ring-offset-background focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none cursor-pointer"
              >
                <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                <span className="sr-only">Remove {tag}</span>
              </button>
            </Badge>
          </motion.div>
        ))}
      </div>
      <Input
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={
          value.length < maxTags ? placeholder : `Max ${maxTags} tags reached`
        }
        disabled={disabled || value.length >= maxTags}
        className="h-9"
      />
      <p className="text-[10px] text-muted-foreground">
        Press Enter or comma to add. Tags must be kebab-case.
      </p>
    </div>
  );
}
