import {
  type UIMessage,
  type InferUITool,
  type InferUITools,
  type UIDataTypes,
} from "ai";
import * as mathTools from "./tools/math.ts";
import * as timeTools from "./tools/time.ts";
import * as fetchTools from "./tools/fetch.ts";
import { createLoadSkillTool } from "./tools/skill.ts";
import {
  createListAgentsTool,
  createListSchedulesTool,
  createScheduleTool,
  createEditScheduleTool,
} from "./tools/schedule.ts";

export type MathTools = InferUITools<typeof mathTools>;
export type TimeTools = InferUITools<typeof timeTools>;
export type FetchTools = InferUITools<typeof fetchTools>;

export type SkillTools = {
  loadSkill: InferUITool<ReturnType<typeof createLoadSkillTool>>;
};

export type ScheduleTools = {
  listAgents: InferUITool<ReturnType<typeof createListAgentsTool>>;
  listSchedules: InferUITool<ReturnType<typeof createListSchedulesTool>>;
  createSchedule: InferUITool<ReturnType<typeof createScheduleTool>>;
  editSchedule: InferUITool<ReturnType<typeof createEditScheduleTool>>;
};

export type PlatypusTools = MathTools &
  TimeTools &
  FetchTools &
  SkillTools &
  ScheduleTools;

export type PlatypusUIMessage = UIMessage<any, UIDataTypes, PlatypusTools>;
