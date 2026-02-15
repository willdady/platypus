import {
  type UIMessage,
  type InferUITool,
  type InferUITools,
  type UIDataTypes,
} from "ai";
import * as mathTools from "./tools/math.ts";
import { createLoadSkillTool } from "./tools/skill.ts";

export type MathTools = InferUITools<typeof mathTools>;

export type SkillTools = {
  loadSkill: InferUITool<ReturnType<typeof createLoadSkillTool>>;
};

export type PlatypusTools = MathTools & SkillTools;

export type PlatypusUIMessage = UIMessage<any, UIDataTypes, PlatypusTools>;
