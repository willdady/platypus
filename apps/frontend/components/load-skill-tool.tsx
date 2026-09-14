"use client";

import { SparklesIcon } from "lucide-react";
import type { ToolUIPart } from "ai";
import { type CustomUITools } from "@platypus/backend/src/types";
import { ToolStatus, toolRowClassName } from "./ai-elements/tool";

/**
 * `loadSkill` is enumerated in `CustomUITools`, so its part carries real
 * input/output types — no assertion needed to read them.
 */
type LoadSkillToolPart = Extract<
  ToolUIPart<CustomUITools>,
  { type: "tool-loadSkill" }
>;

interface LoadSkillToolProps {
  toolPart: LoadSkillToolPart;
}

/**
 * Loading a Skill is a one-shot status line, not an execution record with a
 * body worth reading, so it borrows the tool disclosure's row and nothing
 * else: no chevron, nothing to expand. Deliberately not a `Tool`.
 */
export const LoadSkillTool = ({ toolPart }: LoadSkillToolProps) => {
  const { input, output } = toolPart;
  const errorText =
    toolPart.errorText || (output && "error" in output ? output.error : null);

  return (
    <div className="not-prose mb-4 w-full min-w-0">
      <div className={toolRowClassName}>
        <SparklesIcon className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
          Loading skill{input?.name ? `: ${input.name}` : ""}
        </span>
        <ToolStatus state={errorText ? "output-error" : toolPart.state} />
      </div>
      {errorText && (
        <div className="mt-1 pl-6 text-destructive text-xs">{errorText}</div>
      )}
    </div>
  );
};
