"use client";

import * as React from "react";
import { Textarea } from "./textarea";
import { FieldError } from "./field";

interface TextareaWithCounterProps
  extends React.ComponentProps<typeof Textarea> {
  error?: string;
}

function TextareaWithCounter({
  className,
  maxLength,
  value,
  error,
  ...props
}: TextareaWithCounterProps) {
  const currentLength = typeof value === "string" ? value.length : 0;

  return (
    <div className="w-full">
      <Textarea
        className={className}
        maxLength={maxLength}
        value={value}
        {...props}
      />
      {(maxLength !== undefined || error) && (
        <div className="flex justify-between mt-1">
          {error ? <FieldError>{error}</FieldError> : <div />}
          {maxLength !== undefined && (
            <p className="text-xs text-muted-foreground">
              {currentLength}/{maxLength}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export { TextareaWithCounter };
