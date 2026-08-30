"use client";

import * as React from "react";
import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";

export interface RevealableInputProps extends React.ComponentProps<
  typeof InputGroupInput
> {
  revealLabel?: string;
}

export function RevealableInput({
  revealLabel = "password",
  ...props
}: RevealableInputProps) {
  const [show, setShow] = useState(false);

  return (
    <InputGroup>
      <InputGroupInput {...props} type={show ? "text" : "password"} />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          type="button"
          size="icon-xs"
          onClick={() => setShow(!show)}
          disabled={props.disabled}
          aria-label={show ? `Hide ${revealLabel}` : `Show ${revealLabel}`}
        >
          {show ? <EyeOff /> : <Eye />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}
