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
import { createScheduleTools } from "./tools/schedule.ts";

export type MathTools = InferUITools<typeof mathTools>;
export type TimeTools = InferUITools<typeof timeTools>;
export type FetchTools = InferUITools<typeof fetchTools>;

export type SkillTools = {
  loadSkill: InferUITool<ReturnType<typeof createLoadSkillTool>>;
};

export type ScheduleTools = {
  [K in keyof ReturnType<typeof createScheduleTools>]: InferUITool<
    ReturnType<typeof createScheduleTools>[K]
  >;
};

export type PlatypusTools = MathTools &
  TimeTools &
  FetchTools &
  SkillTools &
  ScheduleTools;

export type PlatypusUIMessage = UIMessage<any, UIDataTypes, PlatypusTools>;
