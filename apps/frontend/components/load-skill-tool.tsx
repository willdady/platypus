"use client";

import { SparklesIcon } from "lucide-react";
import type { ToolUIPart } from "ai";
import { type CustomUITools } from "@platypus/schemas";
import {
  ToolStatus,
  toolRowClassName,
  toolRowIconSlotClassName,
} from "./ai-elements/tool";

type LoadSkillToolPart = Extract<
  ToolUIPart<CustomUITools>,
  { type: "tool-loadSkill" }
>;

type ReadSkillFileToolPart = Extract<
  ToolUIPart<CustomUITools>,
  { type: "tool-readSkillFile" }
>;

function SkillToolRow({
  toolPart,
  label,
}: {
  toolPart: LoadSkillToolPart | ReadSkillFileToolPart;
  label: string;
}) {
  const output: unknown = toolPart.output;
  const errorText =
    toolPart.errorText ||
    (output && typeof output === "object" && "error" in output
      ? String(output.error)
      : null);

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
}

export function LoadSkillTool({ toolPart }: { toolPart: LoadSkillToolPart }) {
  return (
    <SkillToolRow
      toolPart={toolPart}
      label={`Loading skill${toolPart.input?.name ? `: ${toolPart.input.name}` : ""}`}
    />
  );
}

export function ReadSkillFileTool({
  toolPart,
}: {
  toolPart: ReadSkillFileToolPart;
}) {
  return (
    <SkillToolRow
      toolPart={toolPart}
      label={`Reading skill file${toolPart.input?.name && toolPart.input.path ? `: ${toolPart.input.name}/${toolPart.input.path}` : ""}`}
    />
  );
}
