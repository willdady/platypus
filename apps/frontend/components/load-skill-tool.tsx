"use client";

import { SparklesIcon } from "lucide-react";
import type { ToolUIPart } from "ai";
import { type CustomUITools } from "@platypus/backend/src/types";
import {
  ToolStatus,
  toolRowClassName,
  toolRowIconSlotClassName,
} from "./ai-elements/tool";

/**
 * `loadSkill` and `readSkillFile` are enumerated in `CustomUITools`, so their
 * parts carry real input/output types — no assertion needed to read them.
 */
type LoadSkillToolPart = Extract<
  ToolUIPart<CustomUITools>,
  { type: "tool-loadSkill" }
>;

type ReadSkillFileToolPart = Extract<
  ToolUIPart<CustomUITools>,
  { type: "tool-readSkillFile" }
>;

/**
 * A Skill Tool call is a one-shot status line, not an execution record with a
 * body worth reading, so it borrows the tool disclosure's row and nothing
 * else: no chevron, nothing to expand. Deliberately not a `Tool`.
 */
const SkillToolRow = ({
  toolPart,
  label,
}: {
  toolPart: LoadSkillToolPart | ReadSkillFileToolPart;
  label: string;
}) => {
  const { output } = toolPart;
  const errorText =
    toolPart.errorText || (output && "error" in output ? output.error : null);

  return (
    <div className="w-full min-w-0">
      <div className={toolRowClassName}>
        <span className={toolRowIconSlotClassName}>
          <SparklesIcon className="size-4" />
        </span>
        <span className="min-w-0 truncate">{label}</span>
        <ToolStatus state={errorText ? "output-error" : toolPart.state} />
      </div>
      {errorText && (
        <div className="mt-1 pl-8 text-destructive text-xs">{errorText}</div>
      )}
    </div>
  );
};

export const LoadSkillTool = ({
  toolPart,
}: {
  toolPart: LoadSkillToolPart;
}) => (
  <SkillToolRow
    toolPart={toolPart}
    label={`Loading skill${toolPart.input?.name ? `: ${toolPart.input.name}` : ""}`}
  />
);

export const ReadSkillFileTool = ({
  toolPart,
}: {
  toolPart: ReadSkillFileToolPart;
}) => (
  <SkillToolRow
    toolPart={toolPart}
    label={`Reading skill file${toolPart.input?.name && toolPart.input.path ? `: ${toolPart.input.name}/${toolPart.input.path}` : ""}`}
  />
);
