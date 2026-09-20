"use client";

import type { ComponentProps } from "react";
import { Streamdown } from "streamdown";

/**
 * Markdown that is already whole when it renders: card bodies and comments,
 * text widgets, notification bodies, editor previews. The same renderer the
 * Chat draws messages with, minus the two things only a live stream wants —
 * the repair pass for half-written syntax, and the copy/download controls on
 * code blocks and tables.
 */
export const Markdown = (props: ComponentProps<typeof Streamdown>) => (
  <Streamdown controls={false} mode="static" {...props} />
);
