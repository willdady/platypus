"use client";

import type { ComponentProps } from "react";
import { Streamdown } from "streamdown";
import { linkSafety } from "@/components/link-safety";

// why: static, no controls — a card body is whole when it renders, unlike a stream
export function Markdown(props: ComponentProps<typeof Streamdown>) {
  return (
    <Streamdown
      controls={false}
      mode="static"
      linkSafety={linkSafety}
      {...props}
    />
  );
}
