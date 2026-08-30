"use client";

import * as React from "react";
import { Eye, EyeOff } from "lucide-react";

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";

function RevealableInput({
  revealLabel = "password",
  disabled,
  ...props
}: React.ComponentProps<typeof InputGroupInput> & {
  revealLabel?: string;
}) {
  const [revealed, setRevealed] = React.useState(false);

  return (
    <InputGroup>
      <InputGroupInput
        {...props}
        disabled={disabled}
        type={revealed ? "text" : "password"}
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          type="button"
          size="icon-xs"
          onClick={() => setRevealed(!revealed)}
          disabled={disabled}
          aria-label={revealed ? `Hide ${revealLabel}` : `Show ${revealLabel}`}
        >
          {revealed ? <EyeOff /> : <Eye />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}

export { RevealableInput };
